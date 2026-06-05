// Native TS port of Python's `tool_list_providers` — Phase 5 part 13.
//
// Tiny config-driven tool. Iterates KNOWN_PROVIDERS in stable order and
// reports `available` (API key present), `active` (in CFG.providers
// list), and `model` (provider's default model — null when not
// configured).
//
// Inputs: none (the Python signature accepts `_args` but ignores it).
// Outputs: { providers: [{name, available, active, model}], moderator_default, usage_hint }

import type { Provider } from "../providers/types.js";

const KNOWN_PROVIDERS = [
  "anthropic", "openai", "xai", "gemini", "mistral", "groq", "deepseek",
] as const;

const USAGE_HINT =
  "Pass a 'providers' array to confer/debate/plan/review to pick an " +
  "ad-hoc subset, e.g. providers=['openai','gemini']. Omit the field " +
  "to use the configured active set.";

export interface RunListProvidersOptions {
  /** All built providers (any API-key-present provider on the box). */
  providers: Readonly<Record<string, Provider>>;
  /** The "active" subset — which providers CFG considers in-rotation.
   *  Defaults to all available providers when null/undefined (matches
   *  the empty-CFG.providers degenerate). */
  activeProviders?: readonly string[] | null;
  /** Moderator default. Matches Python CFG.moderator; defaults to
   *  "anthropic" when not set. */
  moderatorDefault?: string;
}

export function runListProviders(
  _args: Record<string, unknown>,
  opts: RunListProvidersOptions,
): Record<string, unknown> {
  void _args;
  const active = new Set(opts.activeProviders ?? Object.keys(opts.providers));
  const providers: Record<string, unknown>[] = [];
  for (const name of KNOWN_PROVIDERS) {
    const prov = opts.providers[name];
    providers.push({
      name,
      available: prov !== undefined,
      active:    active.has(name),
      model:     prov ? prov.model : null,
    });
  }
  return {
    providers,
    moderator_default: opts.moderatorDefault ?? "anthropic",
    usage_hint:        USAGE_HINT,
  };
}

export const __test_internals = { KNOWN_PROVIDERS, USAGE_HINT };
