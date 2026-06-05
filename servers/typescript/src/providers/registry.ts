// Provider registry. Mirrors Python's `build_providers()` +
// `ALL_PROVIDERS` module-level dict.
//
// Each provider factory reads its API key from the supplied env and
// returns a `Provider` adapter, or `null` when the key is missing.
// `buildProviders()` filters out the null entries so callers can
// iterate `ALL_PROVIDERS` knowing every entry is usable.
//
// All seven providers from the Python server are represented:
//   anthropic, openai, xai, mistral, groq, deepseek, gemini.

import type { PricingDoc } from "../core/pricing.js";

import { sendAnthropic } from "./anthropic.js";
import { sendGemini } from "./gemini.js";
import {
  OPENAI_COMPAT_DEFAULT_URLS,
  sendOpenAICompatible,
} from "./openai-compatible.js";
import type { Provider, SendArgs, SendResult } from "./types.js";

/** Optional fetchImpl injection point (tests use cassette replay). */
type FetchImpl = NonNullable<Parameters<typeof sendAnthropic>[0]["fetchImpl"]>;

export interface ProviderRegistryOptions {
  /** Map of env-var name → value. Mirrors Python's `ENV` dict. The
   *  factory reads `<PROVIDER>_API_KEY` and `<PROVIDER>_MODEL` from
   *  this map; missing keys → provider is omitted from the registry. */
  env: Readonly<Record<string, string | undefined>>;
  /** Pricing doc; passed through to each provider's send() so cost
   *  augmentation works. Typically `loadPricing()` output. */
  pricing: PricingDoc;
  /** Optional fetch shim — defaults to globalThis.fetch in each adapter. */
  fetchImpl?: FetchImpl;
}

/** Default model per provider — matches Python's `build_providers()`. */
export const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  anthropic: "claude-opus-4-5",
  openai:    "gpt-5",
  xai:       "grok-4-latest",
  mistral:   "mistral-large-latest",
  groq:      "llama-3.3-70b-versatile",
  deepseek:  "deepseek-chat",
  gemini:    "gemini-2.5-pro",
} as const;

/** Build the active provider registry. Returns a `Record<name, Provider>`
 *  with only the providers whose API key is present in `opts.env`.
 *
 *  Provider iteration order in the returned dict matches Python: anthropic,
 *  openai, xai, mistral, groq, deepseek, gemini. */
export function buildProviders(opts: ProviderRegistryOptions): Record<string, Provider> {
  const out: Record<string, Provider> = {};

  // anthropic
  const anthropicKey = opts.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    const model = opts.env["ANTHROPIC_MODEL"] ?? DEFAULT_MODELS.anthropic!;
    out["anthropic"] = makeAnthropicProvider(model, anthropicKey, opts);
  }

  // OpenAI-compatible providers (openai, xai, mistral, groq, deepseek)
  const openAiCompatSpec: Array<{
    name: keyof typeof OPENAI_COMPAT_DEFAULT_URLS;
    keyEnv: string;
    modelEnv: string;
    defaultModel: string;
  }> = [
    { name: "openai",   keyEnv: "OPENAI_API_KEY",   modelEnv: "OPENAI_MODEL",   defaultModel: DEFAULT_MODELS["openai"]! },
    { name: "xai",      keyEnv: "XAI_API_KEY",      modelEnv: "XAI_MODEL",      defaultModel: DEFAULT_MODELS["xai"]! },
    { name: "mistral",  keyEnv: "MISTRAL_API_KEY",  modelEnv: "MISTRAL_MODEL",  defaultModel: DEFAULT_MODELS["mistral"]! },
    { name: "groq",     keyEnv: "GROQ_API_KEY",     modelEnv: "GROQ_MODEL",     defaultModel: DEFAULT_MODELS["groq"]! },
    { name: "deepseek", keyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", defaultModel: DEFAULT_MODELS["deepseek"]! },
  ];
  for (const s of openAiCompatSpec) {
    const apiKey = opts.env[s.keyEnv];
    if (!apiKey) continue;
    const model = opts.env[s.modelEnv] ?? s.defaultModel;
    out[s.name] = makeOpenAICompatibleProvider(s.name, model, apiKey, opts);
  }

  // gemini
  const geminiKey = opts.env["GEMINI_API_KEY"];
  if (geminiKey) {
    const model = opts.env["GEMINI_MODEL"] ?? DEFAULT_MODELS.gemini!;
    out["gemini"] = makeGeminiProvider(model, geminiKey, opts);
  }

  return out;
}

// ----------------------------------------------------------------------
// Per-provider factories. Each closes over (model, apiKey, opts) and
// produces a `Provider` whose send() method calls the appropriate
// adapter.
// ----------------------------------------------------------------------

function makeAnthropicProvider(
  model: string, apiKey: string, opts: ProviderRegistryOptions,
): Provider {
  return {
    name:  "anthropic",
    model,
    send: async (args: SendArgs): Promise<SendResult> => {
      const sendOpts: Parameters<typeof sendAnthropic>[0] = {
        ...args,
        apiKey, model, pricing: opts.pricing,
      };
      if (opts.fetchImpl) sendOpts.fetchImpl = opts.fetchImpl;
      return sendAnthropic(sendOpts);
    },
  };
}

function makeOpenAICompatibleProvider(
  name: keyof typeof OPENAI_COMPAT_DEFAULT_URLS,
  model: string, apiKey: string, opts: ProviderRegistryOptions,
): Provider {
  const url = OPENAI_COMPAT_DEFAULT_URLS[name];
  return {
    name,
    model,
    send: async (args: SendArgs): Promise<SendResult> => {
      const sendOpts: Parameters<typeof sendOpenAICompatible>[0] = {
        ...args,
        provider: name, apiKey, model, url, pricing: opts.pricing,
      };
      if (opts.fetchImpl) sendOpts.fetchImpl = opts.fetchImpl;
      return sendOpenAICompatible(sendOpts);
    },
  };
}

function makeGeminiProvider(
  model: string, apiKey: string, opts: ProviderRegistryOptions,
): Provider {
  return {
    name:  "gemini",
    model,
    send: async (args: SendArgs): Promise<SendResult> => {
      const sendOpts: Parameters<typeof sendGemini>[0] = {
        ...args,
        apiKey, model, pricing: opts.pricing,
      };
      if (opts.fetchImpl) sendOpts.fetchImpl = opts.fetchImpl;
      return sendGemini(sendOpts);
    },
  };
}
