// Pricing & cost computation.
//
// MUST stay byte-equivalent with `_calculate_cost` + `_model_pricing` in
// `servers/python/crosscheck_server.py`. The parity fixture suite
// generates inputs + Python-side expected outputs and the TS test asserts
// byte-equal results.
//
// Wire format expected of `pricing.json` (matches the Python loader):
//   {
//     "<provider>": {
//       "<model>": {
//         "prompt_per_1k":     0.001,
//         "completion_per_1k": 0.003,
//         "cached_per_1k":     0.0005
//       }
//     },
//     "_tiers": { "low":{models:[...]}, "med":{models:[...]}, "high":{models:[...]} }
//   }

import { readFileSync } from "node:fs";

export interface ModelRates {
  prompt_per_1k: number;
  completion_per_1k: number;
  cached_per_1k: number;
}

export interface TierLadder {
  low:  readonly { provider: string; model: string }[];
  med:  readonly { provider: string; model: string }[];
  high: readonly { provider: string; model: string }[];
}

export interface PricingDoc {
  /** `<provider>` -> `<model>` -> ModelRates. */
  [provider: string]: unknown;
}

/** Load a pricing JSON document from disk. Returns `{}` on missing or
 *  invalid file (matching Python's `_load_pricing` degrade-to-empty
 *  behavior). The caller decides whether to warn on stderr.
 *
 *  Pure file I/O — no caching here. Callers can cache the result. */
export function loadPricing(path: string): PricingDoc {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as PricingDoc;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

/** Look up rates for `(provider, model)`. Returns null if either layer is
 *  missing. Mirrors Python's `_model_pricing`. */
export function modelPricing(
  pricing: PricingDoc,
  provider: string,
  model: string,
): ModelRates | null {
  const block = (pricing as Record<string, unknown>)[provider];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const entry = (block as Record<string, unknown>)[model];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  return {
    prompt_per_1k:     numberOrZero(e["prompt_per_1k"]),
    completion_per_1k: numberOrZero(e["completion_per_1k"]),
    cached_per_1k:     numberOrZero(e["cached_per_1k"]),
  };
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0.0;
}

export interface CostResult {
  /** USD cost, rounded to 8 decimal places (mirrors Python's
   *  `round(cost, 8)`). 0.0 when pricing is missing. */
  cost_usd: number;
  /** True when pricing is missing for `(provider, model)`. */
  estimated: boolean;
}

/** Compute the USD cost of a single call. Mirrors `_calculate_cost`:
 *  cached tokens are billed at the cached rate and treated as a SUBSET of
 *  the reported prompt tokens (i.e. effective_prompt = prompt - cached).
 *  Negative inputs are clamped to 0. */
export function calculateCost(
  pricing: PricingDoc,
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): CostResult {
  const rates = modelPricing(pricing, provider, model);
  if (rates === null) {
    return { cost_usd: 0.0, estimated: true };
  }
  const cached = Math.max(0, Math.trunc(cachedTokens));
  const prompt = Math.max(0, Math.trunc(promptTokens) - cached);
  const completion = Math.max(0, Math.trunc(completionTokens));
  const raw =
    (prompt     / 1000.0) * rates.prompt_per_1k +
    (completion / 1000.0) * rates.completion_per_1k +
    (cached     / 1000.0) * rates.cached_per_1k;
  return { cost_usd: roundTo(raw, 8), estimated: false };
}

/** Round to N decimal places using the same semantics as Python's
 *  `round(x, n)` for non-negative inputs at our scales — which on x86/64
 *  matches IEEE-754 banker's rounding on the displayed digits. Using
 *  `toFixed(n)` then parseFloat is sufficient for the costs we produce
 *  (no value exceeds ~1e3 USD per call). The parity tests verify this
 *  produces byte-equal output with Python on the fixture set. */
function roundTo(x: number, n: number): number {
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(n));
}
