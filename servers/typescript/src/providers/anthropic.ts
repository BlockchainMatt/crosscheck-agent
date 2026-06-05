// Anthropic Messages API adapter.
//
// Mirrors `anthropic_provider()` from
// `servers/python/crosscheck_server.py` byte-for-byte across the
// pure-function pieces (request build + response parse). The fetch
// middle is injectable so tests use a cassette replay; production
// uses Node's built-in `fetch`.
//
// API doc: https://docs.anthropic.com/en/api/messages
// Key shape quirks vs. OpenAI's Chat Completions:
//   - `system` goes into a top-level body field, NOT into messages[].
//   - `temperature` is sent only when supportsTemperature() is true
//     (claude-opus-4-7+ rejects it with HTTP 400).
//   - Response shape: `content[].text` blocks concatenated; usage in
//     `usage.input_tokens` / `cache_read_input_tokens` / `output_tokens`.
//   - Anthropic reports cache reads SEPARATELY from input_tokens; the
//     production helper folds them into prompt_tokens so the cost
//     calculation works.

import { calculateCost, type PricingDoc } from "../core/pricing.js";
import { supportsTemperature } from "../core/provider-caps.js";
import type { Usage } from "../core/usage.js";
import {
  type ChatMessage,
  ProviderError,
  type SendArgs,
  type SendResult,
} from "./types.js";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/** Body shape sent to /v1/messages. Strictly typed to keep cross-language
 *  fixtures honest. */
export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string }[];
  system?: string;
  temperature?: number;
}

/** Build the request body + headers for an Anthropic call. Pure-function
 *  — no I/O, no environment reads. The caller passes the API key (so
 *  tests can fixture without leaking secrets). Mirrors the Python
 *  body-construction logic exactly. */
export function buildAnthropicRequest(opts: {
  model: string;
  apiKey: string;
  messages: readonly ChatMessage[];
  maxTokens: number;
  temperature: number;
}): { url: string; headers: Record<string, string>; body: AnthropicRequestBody } {
  // System is a top-level field, not a message.
  let system: string | undefined;
  const convo: { role: string; content: string }[] = [];
  for (const m of opts.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") {
      // Python uses the FIRST system message via `next(... for ...)`.
      if (system === undefined && typeof m.content === "string") {
        system = m.content;
      }
      continue;
    }
    convo.push({ role: m.role, content: typeof m.content === "string" ? m.content : "" });
  }

  const body: AnthropicRequestBody = {
    model:      opts.model,
    max_tokens: opts.maxTokens,
    messages:   convo,
  };
  if (supportsTemperature("anthropic", opts.model)) {
    body.temperature = opts.temperature;
  }
  if (system !== undefined) {
    body.system = system;
  }

  const headers: Record<string, string> = {
    "content-type":      "application/json",
    "x-api-key":          opts.apiKey,
    "anthropic-version":  ANTHROPIC_VERSION_HEADER,
  };

  return { url: ANTHROPIC_API_URL, headers, body };
}

/** Pure-function response parser. Takes the JSON object Anthropic
 *  returns and produces a `{text, usage}` pair (without cost — caller
 *  applies pricing). Mirrors Python's response-handling slice. */
export function parseAnthropicResponse(opts: {
  resp: unknown;
  model: string;
  purpose: string;
}): { text: string; usage: Usage } {
  const r = (opts.resp ?? {}) as Record<string, unknown>;

  // Concatenate every content block's text. Anthropic returns
  // [{type: "text", text: "..."}, ...]; we read .text loosely so a
  // future variant block doesn't crash the parser.
  let text = "";
  const content = r["content"];
  if (!Array.isArray(content)) {
    throw new ProviderError(
      "parse",
      `anthropic: unexpected response shape: ${JSON.stringify(r).slice(0, 200)}`,
    );
  }
  for (const block of content) {
    if (block && typeof block === "object") {
      const t = (block as Record<string, unknown>)["text"];
      if (typeof t === "string") text += t;
    }
  }

  const u = (r["usage"] ?? {}) as Record<string, unknown>;
  const prompt = Math.trunc(Number(u["input_tokens"] ?? 0)) || 0;
  const cached = Math.trunc(Number(u["cache_read_input_tokens"] ?? 0)) || 0;
  const completion = Math.trunc(Number(u["output_tokens"] ?? 0)) || 0;

  const usage: Usage = {
    provider:          "anthropic",
    model:             opts.model,
    // Anthropic reports cache reads separately from input_tokens. The
    // production helper folds them in so prompt_tokens is the FULL
    // input volume; calculateCost then bills the cached subset at the
    // cached rate (cached <= prompt_tokens, since prompt = input+cached).
    prompt_tokens:     prompt + cached,
    completion_tokens: completion,
    cached_tokens:     cached,
    total_tokens:      0,
    cost_usd:          0,
    estimated:         Object.keys(u).length === 0,
    purpose:           opts.purpose,
  };
  // Auto-fill total_tokens to match Python's Usage.to_dict() shape.
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  return { text, usage };
}

/** Apply pricing to a parsed Usage record. Used by `sendAnthropic` and
 *  by anyone post-processing a fixture-driven response. */
export function applyPricing(usage: Usage, pricing: PricingDoc): Usage {
  const { cost_usd, estimated } = calculateCost(
    pricing, usage.provider, usage.model,
    usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens,
  );
  return {
    ...usage,
    cost_usd,
    // estimated stays sticky-true (matches Python's Usage.with_cost()).
    estimated: usage.estimated || estimated,
  };
}

/** End-to-end send. `fetchImpl` defaults to Node's `fetch`; tests pass
 *  a cassette-replay shim. The caller supplies env-resolved bits
 *  (apiKey, model, pricing). */
export async function sendAnthropic(args: SendArgs & {
  apiKey: string;
  model: string;
  pricing: PricingDoc;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response> |
    Promise<{ status: number; headers: Record<string, string>; text(): Promise<string>; json(): Promise<unknown> }>;
}): Promise<SendResult> {
  const { url, headers, body } = buildAnthropicRequest({
    model:       args.model,
    apiKey:      args.apiKey,
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
    throw new ProviderError("network", `anthropic: fetch failed: ${(e as Error).message}`);
  }
  const status = respLike.status;
  if (status >= 200 && status < 300) {
    let parsed: unknown;
    try {
      parsed = await respLike.json();
    } catch (e) {
      throw new ProviderError("parse", `anthropic: response body not JSON: ${(e as Error).message}`);
    }
    const { text, usage } = parseAnthropicResponse({
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
