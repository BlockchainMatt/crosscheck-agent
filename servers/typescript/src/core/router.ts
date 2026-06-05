// Smart router. Mirrors `_router_score` + `_router_recommend` from
// `servers/python/crosscheck_server.py`.
//
// The DB-reading layer (`_router_stats`: usage_log + events_log scans)
// stays a Phase-5 task — at that point we have Storage wired through
// the call path. For now we port the PURE MATH + ranking logic so:
//   - the composite score is byte-equal cross-language;
//   - the cold-start branch + sort order can be parity-tested.
//
// Caller responsibility: pass pre-computed `stats` (typically from
// Storage.listUsageGroupedByProvider + events_log error counts) and
// `providerWeights` (from provider_stats) so the router doesn't reach
// for DB handles itself.

/** Default lookback window for stats (30 days). Matches Python. */
export const ROUTER_DEFAULT_WINDOW_SECONDS = 30 * 24 * 3600;

/** Minimum aggregated `calls` count across the panel before we trust
 *  usage_log enough to rank by it; below this we fall back to the
 *  provider_stats win-rate cold-start path. Matches Python. */
export const ROUTER_COLD_START_THRESHOLD = 5;

/** Per-provider stats entry. Field names match Python's `_router_stats`
 *  output dict so the parity test can JSON.stringify both sides without
 *  translation. */
export interface RouterStats {
  provider: string;
  calls: number;
  errors: number;
  error_rate: number;
  avg_total_tokens: number;
  tokens_sum?: number;
  avg_cost_usd: number;
  avg_wall_ms: number;
}

export interface RouterPick {
  provider: string;
  model: string | null;
  score: number;
  error_rate: number | null;
  calls: number;
  avg_cost_usd: number | null;
  avg_wall_ms: number | null;
  rationale: string;
}

export interface RouterMeta {
  purpose: string;
  n_requested: number;
  n_available: number;
  history_calls: number;
  cold_start: boolean;
  window_seconds: number;
}

export interface RouterRecommendResult {
  recommended: RouterPick[];
  meta: RouterMeta;
}

/** Composite score in [0, 1+]. Higher = better. Mirrors `_router_score`
 *  exactly:
 *    reliability = max(0, 1 - error_rate)               weight 0.6
 *    cost_factor = max(0, 1 - normalized cost)           weight 0.3
 *    engagement  = min(1, avg_total_tokens / 1500)       weight 0.1
 *  Rounded to 4 decimal places via `Number(toFixed(4))`. */
export function routerScore(
  stats: RouterStats,
  minCost: number,
  maxCost: number,
): number {
  const reliability = Math.max(0.0, 1.0 - (stats.error_rate ?? 0.0));
  let costFactor: number;
  if (maxCost > minCost) {
    const costNorm = (stats.avg_cost_usd - minCost) / (maxCost - minCost);
    costFactor = Math.max(0.0, 1.0 - costNorm);
  } else {
    costFactor = 1.0;
  }
  const engagement = Math.min(1.0, (stats.avg_total_tokens ?? 0.0) / 1500.0);
  const raw = 0.6 * reliability + 0.3 * costFactor + 0.1 * engagement;
  return Number(raw.toFixed(4));
}

export interface RouterRecommendArgs {
  purpose: string;
  /** How many providers to recommend. */
  n: number;
  /** Map of provider name → stats. Missing-from-map providers in the
   *  panel get a zero-stats fallback. */
  stats: Readonly<Record<string, RouterStats>>;
  /** Active provider panel (after `available_only` filtering by the
   *  caller). Lowercased provider names. */
  panel: readonly string[];
  /** Lowercased provider names to exclude. */
  exclude?: readonly string[];
  /** Provider win-rate from provider_stats (cold-start signal). 0 when
   *  unknown. */
  providerWeights?: Readonly<Record<string, number>>;
  /** Default model per provider (for the `model` field on each pick).
   *  Null when the provider isn't currently registered. */
  providerModels?: Readonly<Record<string, string | null>>;
  /** Window the caller used to compute `stats`. Echoed back in meta. */
  windowSeconds?: number;
  /** Threshold for cold-start fall-back; defaults to 5. */
  coldStartThreshold?: number;
}

/** Rank providers + return the top N. Mirrors `_router_recommend`
 *  byte-for-byte (sort key, rounding, field shape, rationale strings). */
export function routerRecommend(args: RouterRecommendArgs): RouterRecommendResult {
  const excludeSet = new Set((args.exclude ?? []).map((x) => x.toLowerCase()));
  const panel = args.panel.filter((p) => !excludeSet.has(p));

  // Total `calls` across the stats dict for cold-start detection.
  // Python computes this BEFORE applying exclude, trusting the storage
  // layer's pre-filtering — so we mirror that: sum every stats entry
  // the caller passed in, even those they intend to exclude.
  let historyCalls = 0;
  for (const p of Object.keys(args.stats)) {
    historyCalls += args.stats[p]?.calls ?? 0;
  }
  const coldThreshold = args.coldStartThreshold ?? ROUTER_COLD_START_THRESHOLD;
  const coldStart = historyCalls < coldThreshold;
  const windowSeconds = args.windowSeconds ?? ROUTER_DEFAULT_WINDOW_SECONDS;

  const meta: RouterMeta = {
    purpose:        args.purpose,
    n_requested:    args.n,
    n_available:    panel.length,
    history_calls:  historyCalls,
    cold_start:     coldStart,
    window_seconds: windowSeconds,
  };

  if (coldStart) {
    // Sort by descending provider weight, alphabetical as tiebreaker.
    const weights = args.providerWeights ?? {};
    const ordered = [...panel].sort((a, b) => {
      const dw = (weights[b] ?? 0) - (weights[a] ?? 0);
      if (dw !== 0) return dw;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const recommended: RouterPick[] = [];
    for (const p of ordered.slice(0, args.n)) {
      const s = args.stats[p];
      recommended.push({
        provider:     p,
        model:        args.providerModels?.[p] ?? null,
        score:        Number(((weights[p] ?? 0) as number).toFixed(4)),
        error_rate:   null,
        calls:        s?.calls ?? 0,
        avg_cost_usd: s?.avg_cost_usd ?? null,
        avg_wall_ms:  s?.avg_wall_ms ?? null,
        rationale:    "cold-start; ordered by provider_stats win-rate " +
                       "(insufficient usage_log history for this purpose)",
      });
    }
    return { recommended, meta };
  }

  // Cost normalization across the panel.
  const costs: number[] = [];
  for (const p of panel) {
    const s = args.stats[p];
    if (s) costs.push(s.avg_cost_usd);
  }
  const minCost = costs.length > 0 ? Math.min(...costs) : 0.0;
  const maxCost = costs.length > 0 ? Math.max(...costs) : 0.0;

  // Score every panel provider; missing-from-stats providers get zeros.
  const scored: { score: number; provider: string; stats: RouterStats }[] = [];
  for (const p of panel) {
    const s =
      args.stats[p] ?? {
        provider:         p,
        calls:            0,
        errors:           0,
        error_rate:       0.0,
        avg_total_tokens: 0.0,
        avg_cost_usd:     0.0,
        avg_wall_ms:      0.0,
      };
    scored.push({ score: routerScore(s, minCost, maxCost), provider: p, stats: s });
  }
  // Descending score, alphabetical tiebreak.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  });

  const recommended: RouterPick[] = [];
  for (const row of scored.slice(0, args.n)) {
    const reliability = 1 - row.stats.error_rate;
    recommended.push({
      provider:     row.provider,
      model:        args.providerModels?.[row.provider] ?? null,
      score:        row.score,
      error_rate:   row.stats.error_rate,
      calls:        row.stats.calls,
      avg_cost_usd: Number(row.stats.avg_cost_usd.toFixed(6)),
      avg_wall_ms:  Math.trunc(row.stats.avg_wall_ms),
      // Byte-equal with Python:
      //   f"reliability={1 - error_rate:.2f} calls={calls} avg_cost=${avg_cost_usd:.5f}"
      rationale:
        `reliability=${reliability.toFixed(2)} ` +
        `calls=${row.stats.calls} ` +
        `avg_cost=$${row.stats.avg_cost_usd.toFixed(5)}`,
    });
  }
  return { recommended, meta };
}
