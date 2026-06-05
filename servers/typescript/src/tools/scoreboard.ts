// Native TS port of Python's `tool_scoreboard` — Phase 5 part 16.
//
// Aggregates ballot stats + delegation counts + table totals across
// the full DB into a leaderboard view. Uses two new Storage methods:
//   - listDelegationAggregatesByRequester() — group by (requester,
//     accepted)
//   - countScoreboardTotals() — sessions / claims / claim_links /
//     delegations (best-effort; missing tables degrade to 0)
//
// recent_events is read from an events.jsonl file when configured.
// In v1 we accept an optional `eventsPath` opt and tail it; without
// the path we emit empty recent_events to match Python's "file
// missing" behavior.

import { readFileSync, existsSync } from "node:fs";

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage } from "../adapters/storage/interface.js";

export interface RunScoreboardOptions {
  storage?:    Storage;
  bridge?:     BridgeHandle;
  /** Path to the events.jsonl file. When unset, recent_events is
   *  always empty (matches Python's "file missing" behavior). */
  eventsPath?: string;
}

export async function runScoreboard(
  args: Record<string, unknown>,
  opts: RunScoreboardOptions,
): Promise<Record<string, unknown>> {
  // Storage not wired → defer to bridge or error.
  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("scoreboard")) {
      return await deferScoreboard(args, opts.bridge);
    }
    return errorEnvelope(
      "SCOREBOARD_STORAGE_NOT_NATIVE",
      "scoreboard requires a wired Storage adapter or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }

  const topK = Math.max(1, clampInt(args["top_k"], 1, 10_000, 20));
  const recentLimit = Math.max(0, clampInt(args["recent_limit"], 0, 10_000, 0));

  const storage = opts.storage;
  const statsRows = await storage.listProviderStats();
  const aggregates = await storage.listDelegationAggregatesByRequester();

  // Build (requester → accepted_count, refused_count) maps.
  const delegAcc: Record<string, number> = {};
  const delegRef: Record<string, number> = {};
  for (const a of aggregates) {
    if (a.accepted === 1) {
      delegAcc[a.requester] = (delegAcc[a.requester] ?? 0) + a.count;
    } else {
      delegRef[a.requester] = (delegRef[a.requester] ?? 0) + a.count;
    }
  }

  // Provider rows from provider_stats. Weight = wins/(wins+losses)
  // (excluding abstains) — matches Python exactly. Defaults to 1.0
  // when no committed ballots yet.
  type ProviderRow = {
    provider: string;
    weight:   number;
    wins:     number;
    losses:   number;
    abstains: number;
    last_at:  number | null;
    delegations_accepted: number;
    delegations_refused:  number;
  };
  const rows: ProviderRow[] = [];
  for (const r of statsRows) {
    const wins     = Number(r.wins);
    const losses   = Number(r.losses);
    const abstains = Number(r.abstains);
    const committed = wins + losses;
    const weight = committed > 0 ? wins / committed : 1.0;
    rows.push({
      provider:             r.provider,
      weight:               round4(weight),
      wins, losses, abstains,
      last_at:              r.last_at as number | null,
      delegations_accepted: delegAcc[r.provider] ?? 0,
      delegations_refused:  delegRef[r.provider] ?? 0,
    });
  }

  // Add providers that only appear via delegations.
  const seen = new Set(rows.map((r) => r.provider));
  const delegOnlyNames = new Set([...Object.keys(delegAcc), ...Object.keys(delegRef)]);
  for (const who of delegOnlyNames) {
    if (seen.has(who)) continue;
    rows.push({
      provider: who, weight: 1.0,
      wins: 0, losses: 0, abstains: 0, last_at: null,
      delegations_accepted: delegAcc[who] ?? 0,
      delegations_refused:  delegRef[who] ?? 0,
    });
  }

  // Sort: weight DESC, total_committed DESC, provider ASC.
  // (Python: key = (-weight, -(wins+losses), provider))
  rows.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    const aCommitted = a.wins + a.losses;
    const bCommitted = b.wins + b.losses;
    if (aCommitted !== bCommitted) return bCommitted - aCommitted;
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  });
  const topRows = rows.slice(0, topK);

  const totals = await storage.countScoreboardTotals();

  // Tail the events.jsonl file when configured + the file exists.
  let recentEvents: unknown[] = [];
  if (recentLimit > 0 && opts.eventsPath && existsSync(opts.eventsPath)) {
    try {
      const lines = readFileSync(opts.eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      const tail = lines.slice(-recentLimit);
      for (const ln of tail) {
        try { recentEvents.push(JSON.parse(ln)); }
        catch { /* skip malformed lines, match Python */ }
      }
    } catch {
      recentEvents = [];
    }
  }

  return {
    tool: "scoreboard",
    providers: topRows,
    totals,
    recent_events: recentEvents,
  };
}

function round4(x: number): number {
  // Python's round() uses banker's rounding. For the [0,1] weight
  // range this rarely matters, but we mirror it to be safe.
  if (!Number.isFinite(x)) return x;
  const f = 10_000;
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff  = scaled - floor;
  let rounded: number;
  if (diff > 0.5)      rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else                 rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / f;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function deferScoreboard(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("scoreboard", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "SCOREBOARD_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for scoreboard",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
): Record<string, unknown> {
  return {
    tool:          "scoreboard",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}
