// Per-purpose token-budget resolution.
//
// MUST stay byte-equivalent with `_budget_for_purpose` in
// `servers/python/crosscheck_server.py`. The parity fixture suite
// generates inputs + expected outputs from the Python implementation
// and asserts byte-equal results on the TS side.
//
// Precedence (highest to lowest), matching Python exactly:
//   1. cfg.token_budgets[purpose]                          — global caller override
//   2. cfg.token_budgets_by_provider[provider][purpose]    — per-provider operator override
//   3. PROVIDER_TOKEN_BUDGETS[provider][purpose]           — shipped per-provider override
//   4. NON_REASONING_TOKEN_BUDGETS[purpose]                — non-reasoning model ceiling
//   5. DEFAULT_TOKEN_BUDGETS[purpose]                      — reasoning-safe default
//
// Caller use: const ceiling = budgetForPurpose(p, provider, model, cfg);
// if (ceiling != null && ceiling < requestedMax) requestedMax = ceiling.

import { isReasoningModel } from "./provider-caps.js";

/** Reasoning-safe per-purpose ceilings. These are MINIMUMS for reasoning
 *  models (o-series, gemini-2.5-pro, claude-opus-4-7), which burn
 *  500-2000+ tokens of internal thinking before emitting visible output. */
export const DEFAULT_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  audit:       2048,
  synth:       2048,
  moderator:   2048,
  worker:      2048,
  orchestrate: 2048,
  confer:      2048,
  debate:      2048,
  plan:        2048,
  review:      2048,
  coordinate:  2048,
  solve:       2048,
};

/** Smaller per-purpose ceilings for non-reasoning models. Restores the
 *  PR #7 cost savings for models that don't need the bigger headroom. */
export const NON_REASONING_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  audit:       768,
  synth:       1024,
  moderator:   1024,
  worker:      2048,
  orchestrate: 2048,
  confer:      1500,
  debate:      1500,
  plan:        2048,
  review:      1500,
  coordinate:  1500,
  solve:       2048,
};

/** Shipped per-provider overrides. Applied AFTER the explicit CFG
 *  overrides but BEFORE the reasoning / non-reasoning fall-back. Used
 *  when a particular provider's reasoning budget eats max_completion_tokens
 *  so aggressively that the standard 2048 leaves no room for the answer.
 *
 *  Mirrors `_PROVIDER_TOKEN_BUDGETS` in Python. */
export const PROVIDER_TOKEN_BUDGETS: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  openai: {
    confer:      6144,
    debate:      6144,
    triangulate: 6144,
  },
  gemini: {
    confer:      6144,
    triangulate: 6144,
  },
};

/** Configuration view consumed by budgetForPurpose. Pass through whatever
 *  `crosscheck.config.json` is loaded into; only the two relevant keys
 *  are read. */
export interface BudgetCfg {
  token_budgets?: Record<string, unknown>;
  token_budgets_by_provider?: Record<string, Record<string, unknown>>;
}

/** Resolve the per-purpose ceiling. Returns `null` for unknown purposes
 *  (caller falls through to its own default — typically the per-call
 *  token_cap split). Mirrors `_budget_for_purpose` in Python exactly. */
export function budgetForPurpose(
  purpose: string,
  provider?: string,
  model?: string,
  cfg?: BudgetCfg,
): number | null {
  // Tier 1: global caller override.
  const tb = cfg?.token_budgets;
  if (tb && Object.prototype.hasOwnProperty.call(tb, purpose)) {
    const v = tb[purpose];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) {
      return v;
    }
  }

  if (typeof provider === "string" && provider.length > 0) {
    // Tier 2: per-provider operator override.
    const byProvider = cfg?.token_budgets_by_provider;
    if (byProvider && typeof byProvider === "object") {
      const opTable = byProvider[provider];
      if (opTable && typeof opTable === "object") {
        if (Object.prototype.hasOwnProperty.call(opTable, purpose)) {
          const v = opTable[purpose];
          if (typeof v === "number" && Number.isInteger(v) && v > 0) {
            return v;
          }
        }
      }
    }
    // Tier 3: shipped per-provider override.
    const shipped = PROVIDER_TOKEN_BUDGETS[provider];
    if (shipped && Object.prototype.hasOwnProperty.call(shipped, purpose)) {
      const v = shipped[purpose];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) {
        return v;
      }
    }
  }

  // Tier 4: non-reasoning model ceiling (only when we know the model).
  if (provider && model && !isReasoningModel(provider, model)) {
    const nonr = NON_REASONING_TOKEN_BUDGETS[purpose];
    if (typeof nonr === "number") return nonr;
  }

  // Tier 5: reasoning-safe default.
  const def = DEFAULT_TOKEN_BUDGETS[purpose];
  if (typeof def === "number") return def;

  return null;
}
