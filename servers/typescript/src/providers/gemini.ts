// Gemini adapter (Google Generative Language API).
//
// Mirrors `gemini_provider()` from
// `servers/python/crosscheck_server.py` byte-for-byte across the
// pure-function pieces.
//
// API doc: https://ai.google.dev/api/generate-content
// Key shape quirks vs. OpenAI / Anthropic:
//   - API key goes in the URL query string: `?key=<APIKEY>`. Headers
//     are empty. (Google supports OAuth via header too; the API-key
//     path is what crosscheck-agent uses.)
//   - Messages map to `contents[]` with `role` ∈ {"user", "model"} and
//     `parts: [{text: "..."}]` blocks. `role: "user"` for user messages;
//     EVERY OTHER non-system role (including "assistant") becomes
//     "model" — Gemini's only acceptable values are those two.
//   - System message lifts out to a `systemInstruction: {parts: [...]}`
//     top-level body field.
//   - generationConfig holds `maxOutputTokens` + `temperature` (Gemini
//     uses camelCase, not snake_case).
//   - Response text from `candidates[0].content.parts[].text` joined.
//   - Usage in `usageMetadata.{promptTokenCount, cachedContentTokenCount,
//     candidatesTokenCount, totalTokenCount}`.
//   - Empty `candidates` list is NOT a parse error — returns empty text
//     (matches Python; Gemini emits empty candidates when content is
//     filtered by safety settings).

import { calculateCost, type PricingDoc } from "../core/pricing.js";
import type { Usage } from "../core/usage.js";
import {
  type ChatMessage,
  ProviderError,
  type SendArgs,
  type SendResult,
} from "./types.js";

export const GEMINI_API_URL_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Request body shape sent to /v1beta/models/{model}:generateContent. */
export interface GeminiRequestBody {
  contents: { role: "user" | "model"; parts: { text: string }[] }[];
  generationConfig: { maxOutputTokens: number; temperature: number };
  systemInstruction?: { parts: { text: string }[] };
}

/** Build the request URL + body for a Gemini call. Headers stay empty
 *  (API key lives in the URL). Pure function — no I/O. */
export function buildGeminiRequest(opts: {
  model: string;
  apiKey: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  temperature: number;
}): { url: string; headers: Record<string, string>; body: GeminiRequestBody } {
  const contents: GeminiRequestBody["contents"] = [];
  let systemText: string | null = null;
  for (const m of opts.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") {
      // Python uses the LAST system message because it overwrites in
      // a loop. Mirror that — but production code typically only sends
      // one system message anyway.
      if (typeof m.content === "string") systemText = m.content;
      continue;
    }
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    contents.push({
      role,
      parts: [{ text: typeof m.content === "string" ? m.content : "" }],
    });
  }

  const body: GeminiRequestBody = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      temperature:     opts.temperature,
    },
  };
  if (systemText !== null && systemText !== "") {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Auth key in the URL query string. URL-encode defensively.
  const url = `${GEMINI_API_URL_BASE}/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  return { url, headers: {}, body };
}

/** Pure-function response parser. Mirrors Python's response handling
 *  including the empty-candidates edge case. */
export function parseGeminiResponse(opts: {
  resp: unknown;
  model: string;
  purpose: string;
}): { text: string; usage: Usage } {
  const r = (opts.resp ?? {}) as Record<string, unknown>;

  const u = (r["usageMetadata"] ?? {}) as Record<string, unknown>;
  const prompt = Math.trunc(Number(u["promptTokenCount"] ?? 0)) || 0;
  const cached = Math.trunc(Number(u["cachedContentTokenCount"] ?? 0)) || 0;
  const completion = Math.trunc(Number(u["candidatesTokenCount"] ?? 0)) || 0;
  const total = Math.trunc(Number(u["totalTokenCount"] ?? 0)) || 0;

  const usage: Usage = {
    provider:          "gemini",
    model:             opts.model,
    prompt_tokens:     prompt,
    completion_tokens: completion,
    cached_tokens:     cached,
    total_tokens:      total,
    cost_usd:          0,
    estimated:         Object.keys(u).length === 0,
    purpose:           opts.purpose,
  };
  if (usage.total_tokens === 0) {
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }

  const cands = r["candidates"];
  if (!Array.isArray(cands) || cands.length === 0) {
    // Mirrors Python: returns "" with usage intact (Gemini emits empty
    // candidates when content is safety-filtered).
    return { text: "", usage };
  }
  try {
    const first = cands[0] as Record<string, unknown>;
    const content = first["content"] as Record<string, unknown>;
    const parts = content["parts"] as unknown[];
    let text = "";
    for (const p of parts) {
      if (p && typeof p === "object") {
        const t = (p as Record<string, unknown>)["text"];
        if (typeof t === "string") text += t;
      }
    }
    return { text, usage };
  } catch (e) {
    throw new ProviderError(
      "parse",
      `gemini: unexpected response shape: ${JSON.stringify(r).slice(0, 200)}`,
    );
  }
}

/** Apply pricing to a parsed Usage record. */
export function applyPricing(usage: Usage, pricing: PricingDoc): Usage {
  const { cost_usd, estimated } = calculateCost(
    pricing, usage.provider, usage.model,
    usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens,
  );
  return {
    ...usage,
    cost_usd,
    estimated: usage.estimated || estimated,
  };
}

/** End-to-end send. `fetchImpl` defaults to globalThis.fetch; tests
 *  pass a cassette-replay shim. */
export async function sendGemini(args: SendArgs & {
  apiKey: string;
  model: string;
  pricing: PricingDoc;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response> |
    Promise<{ status: number; headers: Record<string, string>; text(): Promise<string>; json(): Promise<unknown> }>;
}): Promise<SendResult> {
  const { url, headers, body } = buildGeminiRequest({
    model:       args.model,
    apiKey:      args.apiKey,
    messages:    args.messages,
    maxTokens:   args.maxTokens,
    temperature: args.temperature,
  });
  const doFetch = (args.fetchImpl ?? (globalThis.fetch as unknown as typeof args.fetchImpl))!;
  // Gemini sends body as JSON; Python's `_http_post_resilient` adds the
  // Content-Type header but Gemini's body-only POST doesn't strictly
  // require one. We add it for HTTP/1.1 hygiene; matches what Node's
  // fetch would set anyway.
  const init: RequestInit = {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body:   JSON.stringify(body),
  };
  if (args.signal) init.signal = args.signal;

  let respLike: { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    respLike = await doFetch(url, init) as typeof respLike;
  } catch (e) {
    throw new ProviderError("network", `gemini: fetch failed: ${(e as Error).message}`);
  }
  const status = respLike.status;
  if (status >= 200 && status < 300) {
    let parsed: unknown;
    try {
      parsed = await respLike.json();
    } catch (e) {
      throw new ProviderError("parse", `gemini: response body not JSON: ${(e as Error).message}`);
    }
    const { text, usage } = parseGeminiResponse({
      resp: parsed, model: args.model, purpose: args.purpose ?? "worker",
    });
    return { text, attempts: 1, usage: applyPricing(usage, args.pricing) };
  }
  const bodyText = await respLike.text().catch(() => "");
  if (status === 401 || status === 403) {
    throw new ProviderError("auth", `HTTP ${status}: ${bodyText.slice(0, 512)}`, { status });
  }
  if (status === 429) {
    throw new ProviderError("rate_limit", `HTTP ${status}: ${bodyText.slice(0, 512)}`, { status });
  }
  if (status >= 500 && status <= 599) {
    throw new ProviderError("server", `HTTP ${status}: ${bodyText.slice(0, 512)}`, { status });
  }
  throw new ProviderError("client", `HTTP ${status}: ${bodyText.slice(0, 512)}`, { status });
}
