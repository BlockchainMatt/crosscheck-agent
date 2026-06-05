// OpenAI Chat Completions adapter — also used by xAI / Mistral / Groq /
// DeepSeek (every "OpenAI-compatible" endpoint). Mirrors
// `openai_compatible()` from `servers/python/crosscheck_server.py`
// byte-for-byte across the pure-function pieces.
//
// API doc: https://platform.openai.com/docs/api-reference/chat/create
// Key shape quirks vs. Anthropic:
//   - `system` stays in messages[] (role: "system") — no body extraction.
//   - `Authorization: Bearer <key>` header (not x-api-key).
//   - Reasoning models (gpt-5, o-series, claude-opus-4-7 via xAI etc.):
//     use `max_completion_tokens` and OMIT `temperature` + `max_tokens`.
//   - Response text: `choices[0].message.content`.
//   - Usage cached_tokens lives at `usage.prompt_tokens_details.cached_tokens`.
//   - Response includes `total_tokens` directly (we use it as-is rather
//     than re-deriving prompt+completion).

import { calculateCost, type PricingDoc } from "../core/pricing.js";
import { supportsTemperature } from "../core/provider-caps.js";
import type { Usage } from "../core/usage.js";
import {
  type ChatMessage,
  ProviderError,
  type SendArgs,
  type SendResult,
} from "./types.js";

/** Default endpoints for each OpenAI-compatible provider. Callers can
 *  override per-provider when the API moves. */
export const OPENAI_COMPAT_DEFAULT_URLS = {
  openai:   "https://api.openai.com/v1/chat/completions",
  xai:      "https://api.x.ai/v1/chat/completions",
  mistral:  "https://api.mistral.ai/v1/chat/completions",
  groq:     "https://api.groq.com/openai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
} as const;

/** Request body shape. The `max_tokens` vs `max_completion_tokens` choice
 *  is determined by whether the model is reasoning-class. */
export interface OpenAIRequestBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
}

/** Build the request body + headers for an OpenAI-compatible call. Pure
 *  function — no I/O. Mirrors Python's body-construction logic. */
export function buildOpenAICompatibleRequest(opts: {
  /** Lowercased provider name (e.g. "openai"); used for reasoning-class
   *  detection via PROVIDER_CAPS. */
  provider: string;
  model: string;
  apiKey: string;
  url: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  temperature: number;
}): { url: string; headers: Record<string, string>; body: OpenAIRequestBody } {
  // Messages pass through unchanged (system stays in the array).
  const msgs = opts.messages.map((m) => ({
    role:    m.role,
    content: typeof m.content === "string" ? m.content : "",
  }));

  const body: OpenAIRequestBody = {
    model:    opts.model,
    messages: msgs,
  };
  if (supportsTemperature(opts.provider, opts.model)) {
    body.max_tokens   = opts.maxTokens;
    body.temperature  = opts.temperature;
  } else {
    // Reasoning models reject `temperature` and require
    // `max_completion_tokens`.
    body.max_completion_tokens = opts.maxTokens;
  }

  const headers: Record<string, string> = {
    "content-type":  "application/json",
    Authorization:   `Bearer ${opts.apiKey}`,
  };

  return { url: opts.url, headers, body };
}

/** Pure-function response parser. Throws ProviderError("parse") on
 *  shape mismatch. Mirrors Python's response-handling. */
export function parseOpenAICompatibleResponse(opts: {
  resp: unknown;
  provider: string;
  model: string;
  purpose: string;
}): { text: string; usage: Usage } {
  const r = (opts.resp ?? {}) as Record<string, unknown>;

  // Text: choices[0].message.content. Any access failure → parse error.
  let text: string;
  try {
    const choices = r["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error("choices missing or empty");
    }
    const first = choices[0] as Record<string, unknown>;
    const message = first["message"] as Record<string, unknown> | undefined;
    if (!message || typeof message["content"] !== "string") {
      throw new Error("message.content missing or not string");
    }
    text = message["content"] as string;
  } catch (e) {
    throw new ProviderError(
      "parse",
      `${opts.provider}: unexpected response shape: ${JSON.stringify(r).slice(0, 200)}`,
    );
  }

  // Usage: prompt_tokens / completion_tokens / total_tokens, plus the
  // cached subset under prompt_tokens_details.cached_tokens.
  const u = (r["usage"] ?? {}) as Record<string, unknown>;
  const details = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const cached = Math.trunc(Number(details["cached_tokens"] ?? 0)) || 0;

  const usage: Usage = {
    provider:          opts.provider,
    model:             opts.model,
    prompt_tokens:     Math.trunc(Number(u["prompt_tokens"] ?? 0)) || 0,
    completion_tokens: Math.trunc(Number(u["completion_tokens"] ?? 0)) || 0,
    cached_tokens:     cached,
    // Use the response's reported total_tokens directly. Python's
    // `Usage.to_dict()` falls back to prompt+completion only when
    // total_tokens is 0/missing; mirror that.
    total_tokens:      Math.trunc(Number(u["total_tokens"] ?? 0)) || 0,
    cost_usd:          0,
    estimated:         Object.keys(u).length === 0,
    purpose:           opts.purpose,
  };
  if (usage.total_tokens === 0) {
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }

  return { text, usage };
}

/** Apply pricing to a parsed Usage record. Identical semantics to
 *  Anthropic's `applyPricing` — kept separate so each adapter stays
 *  self-contained for downstream tooling that imports just one. */
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

/** End-to-end send for any OpenAI-compatible endpoint. Tests inject
 *  `fetchImpl`; production uses globalThis.fetch. */
export async function sendOpenAICompatible(args: SendArgs & {
  provider: string;
  apiKey: string;
  model: string;
  url: string;
  pricing: PricingDoc;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response> |
    Promise<{ status: number; headers: Record<string, string>; text(): Promise<string>; json(): Promise<unknown> }>;
}): Promise<SendResult> {
  const { url, headers, body } = buildOpenAICompatibleRequest({
    provider:    args.provider,
    model:       args.model,
    apiKey:      args.apiKey,
    url:         args.url,
    messages:    args.messages,
    maxTokens:   args.maxTokens,
    temperature: args.temperature,
  });
  const doFetch = (args.fetchImpl ?? (globalThis.fetch as unknown as typeof args.fetchImpl))!;
  const init: RequestInit = {
    method: "POST",
    headers,
    body:   JSON.stringify(body),
  };
  if (args.signal) init.signal = args.signal;

  let respLike: { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    respLike = await doFetch(url, init) as typeof respLike;
  } catch (e) {
    throw new ProviderError("network", `${args.provider}: fetch failed: ${(e as Error).message}`);
  }
  const status = respLike.status;
  if (status >= 200 && status < 300) {
    let parsed: unknown;
    try {
      parsed = await respLike.json();
    } catch (e) {
      throw new ProviderError("parse", `${args.provider}: response body not JSON: ${(e as Error).message}`);
    }
    const { text, usage } = parseOpenAICompatibleResponse({
      resp:     parsed,
      provider: args.provider,
      model:    args.model,
      purpose:  args.purpose ?? "worker",
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
