// Native TS port of Python's `tool_recommend_panel` — Phase 5 part 21.
//
// Thin glue over the Phase-2-ported `routerRecommend()` core. Pulls
// per-purpose usage stats + per-provider weights from Storage, builds
// the active panel from opts.providers, and delegates the scoring +
// ranking + cold-start logic to routerRecommend.
//
// One deliberate divergence from Python documented in the storage
// interface (see listRouterStatsByPurpose):
//   - Python tails events.jsonl for provider_call error counts.
//   - TS doesn't write an events log; we report error_rate=0 across
//     the board. The composite score's reliability component
//     therefore always = 1.0, which makes the score reflect cost +
//     engagement only. This is fine for tier-1 use (small-panel
//     selection); a future PR can write events.jsonl + read it here.

import {
  routerRecommend,
  ROUTER_DEFAULT_WINDOW_SECONDS,
  type RouterStats,
} from "../core/router.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage } from "../adapters/storage/interface.js";
import type { Provider } from "../providers/types.js";

export interface RunRecommendPanelOptions {
  /** Available providers — when present, defines the candidate panel
   *  and supplies the default-model field on each recommendation. */
  providers: Readonly<Record<string, Provider>>;
  storage?: Storage;
  bridge?:  BridgeHandle;
  /** Epoch seconds — lets tests pin the since_days filter. */
  nowEpochSeconds?: () => number;
}

export async function runRecommendPanel(
  args: Record<string, unknown>,
  opts: RunRecommendPanelOptions,
): Promise<Record<string, unknown>> {
  const purpose = typeof args["purpose"] === "string" ? args["purpose"] : "";
  if (!purpose) {
    return errorEnvelope(
      "RECOMMEND_PANEL_MISSING_PURPOSE",
      "must provide `purpose`",
      "Pass a purpose like 'confer', 'audit', 'worker', etc.",
    );
  }

  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("recommend_panel")) {
      return await deferRecommendPanel(args, opts.bridge);
    }
    return errorEnvelope(
      "RECOMMEND_PANEL_STORAGE_NOT_NATIVE",
      "recommend_panel requires a wired Storage adapter or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }

  const n = Math.max(1, clampInt(args["n"], 1, 100, 2));
  const exclude = toStringArray(args["exclude"]).map((s) => s.toLowerCase());
  const sinceDays = clampInt(args["since_days"], 0, 365 * 10, 30);
  const availableOnly = boolArg(args["available_only"], true);

  // Window in seconds. routerRecommend wants this echoed in meta.
  const windowSeconds = sinceDays * 24 * 3600;
  const nowSeconds = opts.nowEpochSeconds ? opts.nowEpochSeconds() : Math.floor(Date.now() / 1000);
  const sinceMs = (nowSeconds - windowSeconds) * 1000;

  // Stats by provider for this purpose.
  const rawStats = await opts.storage.listRouterStatsByPurpose(purpose, sinceMs);
  const stats: Record<string, RouterStats> = {};
  for (const r of rawStats) {
    stats[r.provider] = {
      provider:         r.provider,
      calls:            r.calls,
      errors:           0,         // TS doesn't write events log
      error_rate:       0.0,       // ditto — see file header
      avg_total_tokens: r.avg_total_tokens,
      tokens_sum:       r.tokens_sum,
      avg_cost_usd:     r.avg_cost_usd,
      avg_wall_ms:      r.avg_wall_ms,
    };
  }

  // Panel: when available_only, the registered providers; else
  // the providers we have stats for (matches Python).
  const panel = availableOnly
    ? Object.keys(opts.providers).map((s) => s.toLowerCase())
    : Object.keys(stats);

  // Provider weights from provider_stats — used by the cold-start
  // fallback. Default 1.0 when missing (fresh DB → 1.0 for all).
  const providerStats = await opts.storage.listProviderStats();
  const providerWeights: Record<string, number> = {};
  for (const ps of providerStats) {
    const committed = ps.wins + ps.losses;
    providerWeights[ps.provider.toLowerCase()] =
      committed > 0 ? ps.wins / committed : 1.0;
  }
  // Providers without stats default to 1.0 (matches Python's
  // `_provider_weight` fallback). routerRecommend expects them to be
  // explicitly present in the weights map.
  for (const p of panel) {
    if (!(p in providerWeights)) providerWeights[p] = 1.0;
  }

  // Provider models for the model field on each recommendation.
  const providerModels: Record<string, string | null> = {};
  for (const [name, prov] of Object.entries(opts.providers)) {
    providerModels[name.toLowerCase()] = prov.model ?? null;
  }
  for (const p of panel) {
    if (!(p in providerModels)) providerModels[p] = null;
  }

  const result = routerRecommend({
    purpose,
    n,
    stats,
    panel,
    exclude,
    providerWeights,
    providerModels,
    windowSeconds: windowSeconds || ROUTER_DEFAULT_WINDOW_SECONDS,
  });

  return {
    tool:        "recommend_panel",
    recommended: result.recommended,
    meta:        result.meta,
  };
}

// ---------- helpers ----------

async function deferRecommendPanel(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("recommend_panel", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "RECOMMEND_PANEL_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for recommend_panel",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
): Record<string, unknown> {
  return {
    tool:          "recommend_panel",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function boolArg(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null) return defaultVal;
  return Boolean(v);
}
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
