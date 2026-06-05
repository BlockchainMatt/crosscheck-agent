// Usage + aggregation. Mirrors the `Usage` dataclass + `_aggregate_usage`
// + the relevant slice of `_attach_usage_block` in
// `servers/python/crosscheck_server.py`.
//
// Every tool result carries a `usage` block (per-call + per-provider +
// totals) so the operator can see exactly what each turn cost. The
// rollup math has to be byte-equal across languages because the parity
// fixtures compare JSON-stringified output.

import { calculateCost, type PricingDoc } from "./pricing.js";

/** One provider call's token + cost record. Mirrors `Usage.to_dict()`
 *  output exactly. */
export interface Usage {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: boolean;
  purpose: string;
}

/** Build an empty Usage record. Mirrors `Usage.empty(...)`. */
export function emptyUsage(provider: string, model: string, purpose = "worker"): Usage {
  return {
    provider, model, purpose,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
    cost_usd: 0.0,
    estimated: true,
  };
}

/** Populate `cost_usd` from pricing data. Mirrors `Usage.with_cost()`:
 *  - estimated stays sticky-true; a successful cost lookup never clears
 *    a previously-set estimated=true.
 *  - total_tokens auto-fills from prompt+completion when zero. */
export function withCost(u: Usage, pricing: PricingDoc): Usage {
  const { cost_usd, estimated } = calculateCost(
    pricing, u.provider, u.model, u.prompt_tokens, u.completion_tokens, u.cached_tokens,
  );
  const totalTokens = u.total_tokens || (u.prompt_tokens + u.completion_tokens);
  return {
    ...u,
    cost_usd,
    estimated: u.estimated || estimated,
    total_tokens: totalTokens,
  };
}

/** Per-provider rollup row inside `usage.by_provider[]`. */
export interface ByProviderRow {
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
  estimated: boolean;
}

export interface UsageBlock {
  by_call:     Usage[];
  by_provider: ByProviderRow[];
  totals: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    cost_usd: number;
    estimated: boolean;
    calls: number;
  };
}

/** Round to 8 decimal places via `Number(toFixed(...))`. Matches Python's
 *  `round(x, 8)` for our cost-range inputs (verified by the pricing
 *  parity fixture). */
function roundCost(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(8));
}

/** Roll up a list of `Usage` records into the standard `usage` block.
 *  Mirrors `_aggregate_usage`:
 *    - by_call:     each row as-is.
 *    - by_provider: grouped by `provider` field, summed; calls counts
 *                   per-provider call count; estimated sticky-OR across
 *                   the group.
 *    - totals.total_tokens: prompt + completion (NOT cached) — matches
 *      Python's `int(total_prompt + total_completion)`.
 *    - totals.cost_usd / by_provider.cost_usd rounded to 8 dp.
 *
 *  Provider iteration order matches Python's `dict.setdefault()`
 *  insertion order — first-seen wins. */
export function aggregateUsage(usages: readonly Usage[]): UsageBlock {
  const byCall: Usage[] = usages.map((u) => ({ ...u }));
  // Map preserves insertion order; mirrors Python dict.setdefault.
  const byProvider = new Map<string, ByProviderRow>();
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;
  let anyEstimated = false;
  for (const u of usages) {
    let bp = byProvider.get(u.provider);
    if (!bp) {
      bp = {
        provider:          u.provider,
        prompt_tokens:     0,
        completion_tokens: 0,
        cached_tokens:     0,
        total_tokens:      0,
        cost_usd:          0.0,
        calls:             0,
        estimated:         false,
      };
      byProvider.set(u.provider, bp);
    }
    bp.prompt_tokens     += u.prompt_tokens;
    bp.completion_tokens += u.completion_tokens;
    bp.cached_tokens     += u.cached_tokens;
    bp.total_tokens      += u.total_tokens;
    bp.cost_usd           = roundCost(bp.cost_usd + u.cost_usd);
    bp.calls             += 1;
    bp.estimated          = bp.estimated || u.estimated;
    totalPrompt     += u.prompt_tokens;
    totalCompletion += u.completion_tokens;
    totalCached     += u.cached_tokens;
    totalCost       += u.cost_usd;
    anyEstimated     = anyEstimated || u.estimated;
  }
  return {
    by_call:     byCall,
    by_provider: Array.from(byProvider.values()),
    totals: {
      prompt_tokens:     totalPrompt,
      completion_tokens: totalCompletion,
      cached_tokens:     totalCached,
      // NOTE: total_tokens = prompt + completion (excludes cached). This
      // matches Python's `_aggregate_usage` exactly.
      total_tokens:      totalPrompt + totalCompletion,
      cost_usd:          roundCost(totalCost),
      estimated:         anyEstimated,
      calls:             usages.length,
    },
  };
}
