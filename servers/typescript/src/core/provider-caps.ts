// Provider capability table.
//
// MUST stay byte-equivalent with `PROVIDER_CAPS` in
// `servers/python/crosscheck_server.py`. Adding / changing a provider
// requires updating both sides in lockstep; the parity tests will fail
// if they drift.
//
// `reasoning_prefixes`: model-name prefix list used by isReasoningModel().
// Model-stamp suffixes (e.g. `claude-opus-4-7-20251224`) still match.

export type SupportsTemperature = true | "model";

export interface ProviderCaps {
  family: "anthropic" | "openai_chat" | "gemini";
  /** "separate": system message goes in body.system field.
   *  "inline":   first messages entry with role=system. */
  system_role: "separate" | "inline";
  /** true: always sends temperature. "model": gates on isReasoningModel(). */
  supports_temperature: SupportsTemperature;
  /** Optional list of reasoning-class model-name prefixes. */
  reasoning_prefixes?: readonly string[];
}

export const PROVIDER_CAPS: Readonly<Record<string, ProviderCaps>> = {
  anthropic: {
    family: "anthropic",
    system_role: "separate",
    supports_temperature: "model",
    reasoning_prefixes: ["claude-opus-4-7"],
  },
  openai: {
    family: "openai_chat",
    system_role: "inline",
    supports_temperature: "model",
    reasoning_prefixes: ["gpt-5", "o1", "o3", "o4"],
  },
  xai:      { family: "openai_chat", system_role: "inline",   supports_temperature: true },
  mistral:  { family: "openai_chat", system_role: "inline",   supports_temperature: true },
  groq:     { family: "openai_chat", system_role: "inline",   supports_temperature: true },
  deepseek: { family: "openai_chat", system_role: "inline",   supports_temperature: true },
  gemini: {
    family: "gemini",
    system_role: "separate",
    supports_temperature: true,
    reasoning_prefixes: ["gemini-2.5-pro"],
  },
};

/** True when the model is reasoning-class (gpt-5, o-series,
 *  claude-opus-4-7+, gemini-2.5-pro). Used by `budgetForPurpose` to
 *  give these models more completion headroom.
 *
 *  Mirrors `_is_reasoning_model` in Python. */
export function isReasoningModel(provider: string, model: string): boolean {
  const caps = PROVIDER_CAPS[provider];
  if (!caps) return false;
  const prefixes = caps.reasoning_prefixes ?? [];
  if (prefixes.length === 0) return false;
  if (typeof model !== "string") return false;
  const m = model.toLowerCase();
  return prefixes.some((p) => m.startsWith(p));
}

/** Mirrors `_supports_temperature` in Python. */
export function supportsTemperature(provider: string, model: string): boolean {
  const caps = PROVIDER_CAPS[provider];
  if (!caps) return true;
  if (caps.supports_temperature === true) return true;
  if (caps.supports_temperature === "model") return !isReasoningModel(provider, model);
  return Boolean(caps.supports_temperature);
}
