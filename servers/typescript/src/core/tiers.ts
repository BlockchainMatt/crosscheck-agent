// Tier ladder + cheap-mode model selection.
//
// Mirrors `_tier_ladder` + the math-only slice of `_select_for_difficulty`
// from `servers/python/crosscheck_server.py`. The "what tier does each
// provider/model live in" data lives in `pricing.json` under the `_tiers`
// key (low / med / high). `cheap_mode` work picks the cheapest entry in
// the tier for a typical call (synthetic 1k prompt + 256 completion).
//
// The PURE-MATH piece of selection lives here. The wrapper that consults
// `ALL_PROVIDERS` (active registry) + `_retarget_provider` (rebuild with
// overridden default model) lives in a later phase, when the provider
// registry is ported.

import { modelPricing, type PricingDoc } from "./pricing.js";
import { pyListRepr } from "./pyrepr.js";

/** The three difficulty tiers, in ascending difficulty / cost. Order
 *  matches Python's `_DIFFICULTY_TIERS` constant. */
export const DIFFICULTY_TIERS = ["low", "med", "high"] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

/** A single tier entry — a candidate model in that tier. */
export interface TierEntry {
  provider: string;
  model: string;
}

/** Parsed tier ladder: tier name → ordered list of candidate models. */
export type TierLadder = Partial<Record<DifficultyTier, TierEntry[]>>;

/** Parse the `_tiers` block out of a pricing doc. Returns a fully-typed
 *  ladder; missing/invalid tiers are silently dropped. Mirrors
 *  `_tier_ladder` from Python byte-for-byte. */
export function tierLadder(pricing: PricingDoc): TierLadder {
  const tiers = (pricing as Record<string, unknown>)["_tiers"];
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) return {};
  const tobj = tiers as Record<string, unknown>;
  const out: TierLadder = {};
  for (const name of DIFFICULTY_TIERS) {
    const spec = tobj[name];
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const models = (spec as Record<string, unknown>)["models"];
    if (!Array.isArray(models)) continue;
    const entries: TierEntry[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const mo = m as Record<string, unknown>;
      const provider = String(mo["provider"] ?? "");
      const model = String(mo["model"] ?? "");
      if (provider && model) entries.push({ provider, model });
    }
    out[name] = entries;
  }
  return out;
}

// pyListRepr is centralised in core/pyrepr.ts (used by verify, audit, …).


/** Typical-call cost for one tier entry: 1k prompt + 256 completion at
 *  the entry's rates. When pricing is missing all three rates default
 *  to 0. Matches Python's exact arithmetic. */
export function typicalCallCost(pricing: PricingDoc, entry: TierEntry): number {
  const rates = modelPricing(pricing, entry.provider, entry.model) ?? {
    prompt_per_1k:     0.0,
    completion_per_1k: 0.0,
    cached_per_1k:     0.0,
  };
  return rates.prompt_per_1k + 0.256 * rates.completion_per_1k;
}

/** A scored candidate in the cheap-mode selection. */
export interface ScoredCandidate {
  provider: string;
  model: string;
  /** Typical-call cost (lower = better). */
  cost: number;
  /** Provider win-rate weight (higher = better). */
  weight: number;
}

export interface SelectArgs {
  pricing: PricingDoc;
  tier: DifficultyTier | string;
  /** Lowercased provider names to skip. */
  exclude?: readonly string[];
  /** When non-empty, only providers in this list are considered. */
  allowOnly?: readonly string[];
  /** Set of currently-available (i.e. API-keyed) provider names. */
  availableProviders: ReadonlySet<string>;
  /** Provider win-rate weights (provider_stats); default 0 when missing. */
  providerWeights?: Readonly<Record<string, number>>;
}

export interface SelectResult {
  /** The chosen entry, or null when nothing in the tier is available. */
  pick: TierEntry | null;
  /** Human-readable reason when `pick` is null. */
  reason: string | null;
  /** All scored candidates considered, in evaluation order — useful for
   *  telemetry + the parity test. */
  scored: ScoredCandidate[];
}

/** Pure-function port of `_select_for_difficulty`. Caller supplies the
 *  active-provider set + win-rate weights (typically from Storage); we
 *  do the ranking + tiebreak math byte-equal with Python:
 *
 *    sort key = (cost ASC, -weight ASC, provider ASC, model ASC)
 *
 *  Python's `scored.sort()` uses tuple comparison, so the tiebreak
 *  cascades through provider name then model name lexicographically.
 *  We mirror that exact comparator. */
export function selectForDifficulty(args: SelectArgs): SelectResult {
  const tier = args.tier as DifficultyTier;
  if (!DIFFICULTY_TIERS.includes(tier)) {
    return { pick: null, reason: `unknown difficulty: '${args.tier}'`, scored: [] };
  }
  const ladder = tierLadder(args.pricing);
  const candidates = ladder[tier] ?? [];
  if (candidates.length === 0) {
    return {
      pick: null,
      reason: `no models configured for tier '${tier}'`,
      scored: [],
    };
  }
  const excl = new Set((args.exclude ?? []).map((s) => s.toLowerCase()));
  const allow =
    args.allowOnly && args.allowOnly.length > 0
      ? new Set(args.allowOnly.map((s) => s.toLowerCase()))
      : null;
  const weights = args.providerWeights ?? {};
  const scored: ScoredCandidate[] = [];
  for (const entry of candidates) {
    const prov = entry.provider.toLowerCase();
    if (excl.has(prov)) continue;
    if (allow !== null && !allow.has(prov)) continue;
    if (!args.availableProviders.has(prov)) continue;
    scored.push({
      provider: prov,
      model:    entry.model,
      cost:     typicalCallCost(args.pricing, entry),
      weight:   weights[prov] ?? 0.0,
    });
  }
  if (scored.length === 0) {
    return {
      pick:   null,
      // Match Python's `str(list)` format byte-for-byte: single-quoted
      // strings, comma-space separator. Python prints `None` for null.
      reason: `no available provider in tier '${tier}' ` +
              `(after exclude=${pyListRepr(Array.from(excl))}, ` +
              `allow_only=${args.allowOnly ? pyListRepr(args.allowOnly) : "None"})`,
      scored: [],
    };
  }
  scored.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    // Python tuple cmp uses -weight; lower negated-weight comes first,
    // i.e. HIGHER weight wins. Mirror via descending weight.
    if (a.weight !== b.weight) return b.weight - a.weight;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.model    !== b.model)    return a.model    < b.model    ? -1 : 1;
    return 0;
  });
  const pick = scored[0]!;
  return {
    pick:   { provider: pick.provider, model: pick.model },
    reason: null,
    scored,
  };
}
