// Native TS port of Python's `tool_explain` — Phase 5 part 17.
//
// Session replay tool. Loads usage_log rows + matching transcript
// files, applies optional filters (only_purpose / only_provider),
// builds per-purpose + per-provider rollups, computes totals from
// the session row, and renders an ASCII tree of the call hierarchy.
//
// Storage uses: getSession, listUsageForSession.
// Filesystem: read transcripts/*.json, filter by session_id match.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage, UsageLogRow } from "../adapters/storage/interface.js";

export interface RunExplainOptions {
  storage?:        Storage;
  bridge?:         BridgeHandle;
  /** Directory holding the transcript JSON files. When unset, the
   *  transcripts list is empty (matches Python's "dir missing"). */
  transcriptsDir?: string;
}

export async function runExplain(
  args: Record<string, unknown>,
  opts: RunExplainOptions,
): Promise<Record<string, unknown>> {
  const sessionId = args["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") {
    return errorEnvelope(
      "EXPLAIN_MISSING_SESSION_ID",
      "must provide `session_id`",
      "Pass the session_id of a previous tool run.",
    );
  }

  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("explain")) {
      return await deferExplain(args, opts.bridge);
    }
    return errorEnvelope(
      "EXPLAIN_STORAGE_NOT_NATIVE",
      "explain requires a wired Storage adapter or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }

  const storage = opts.storage;
  const session = await storage.getSession(sessionId);
  if (!session || !session.calls || session.calls === 0) {
    return errorEnvelope(
      "EXPLAIN_NO_SESSION",
      `no session found for session_id=${pyRepr(sessionId)}`,
      "Either the session never ran a multi-LLM tool, or the session_id " +
        "is wrong.",
      "client",
      { session_id: sessionId },
    );
  }

  const includeText    = boolArg(args["include_text"], true);
  const maxTranscripts = Math.max(1, clampInt(args["max_transcripts"], 1, 10_000, 50));
  const purposeFilter  = new Set(toStringArray(args["only_purpose"]));
  const providerFilter = new Set(toStringArray(args["only_provider"]));

  // 1. Per-call rows from usage_log.
  const allRows = await storage.listUsageForSession(sessionId);
  // Apply optional filters BEFORE the rollups (matches Python).
  const rows = allRows.filter((r) => {
    if (purposeFilter.size > 0 && !purposeFilter.has(String(r.purpose ?? ""))) return false;
    if (providerFilter.size > 0 && !providerFilter.has(String(r.provider ?? ""))) return false;
    return true;
  });

  // 2. Transcripts (capped).
  const transcripts = opts.transcriptsDir
    ? loadTranscriptsForSession(opts.transcriptsDir, sessionId).slice(0, maxTranscripts)
    : [];
  const transcriptsSummary = transcripts.map(summarizeTranscript);

  // 3. Aggregate per-purpose + per-provider rollups.
  type Rollup = {
    calls: number;
    tokens: number;
    cost_usd: number;
    wall_ms: number;
    cpu_ms: number;
  };
  const byPurpose: Record<string, Rollup> = {};
  const byProvider: Record<string, Rollup> = {};
  for (const r of rows) {
    const purpose = r.purpose ?? "worker";
    const provider = r.provider ?? "?";
    const bp = byPurpose[purpose] ??= {
      calls: 0, tokens: 0, cost_usd: 0, wall_ms: 0, cpu_ms: 0,
    };
    bp.calls    += 1;
    bp.tokens   += int(r.total_tokens);
    bp.cost_usd  = round8(bp.cost_usd + Number(r.cost_usd ?? 0));
    bp.wall_ms  += int(r.wall_ms);
    bp.cpu_ms   += int(r.cpu_ms);
    const pp = byProvider[provider] ??= {
      calls: 0, tokens: 0, cost_usd: 0, wall_ms: 0, cpu_ms: 0,
    };
    pp.calls    += 1;
    pp.tokens   += int(r.total_tokens);
    pp.cost_usd  = round8(pp.cost_usd + Number(r.cost_usd ?? 0));
    pp.wall_ms  += int(r.wall_ms);
    pp.cpu_ms   += int(r.cpu_ms);
  }

  const totals = {
    calls:          int(session.calls),
    wall_ms:        int(session.wall_ms ?? 0),
    cpu_ms:         int(session.total_cpu_ms ?? 0),
    total_tokens:   int(session.total_tokens ?? 0),
    total_cost_usd: round8(Number(session.total_cost_usd ?? 0)),
    cache_hits:     int(session.cache_hits ?? 0),
  };

  // 4. Pre-render ASCII tree.
  const text = includeText
    ? renderAsciiTree(sessionId, totals, rows)
    : null;

  const result: Record<string, unknown> = {
    tool:        "explain",
    session_id:  sessionId,
    totals,
    by_purpose:  byPurpose,
    by_provider: byProvider,
    rows,
    transcripts: transcriptsSummary,
  };
  if (purposeFilter.size > 0 || providerFilter.size > 0) {
    result["applied_filters"] = {
      only_purpose:  purposeFilter.size > 0
        ? Array.from(purposeFilter).sort() : null,
      only_provider: providerFilter.size > 0
        ? Array.from(providerFilter).sort() : null,
    };
  }
  if (includeText) result["text"] = text;
  return result;
}

// ---------- filesystem: transcripts dir reader ----------

interface TranscriptEntry {
  path:     string;
  doc:      Record<string, unknown>;
  mtime_ms: number;
}

function loadTranscriptsForSession(dir: string, sessionId: string): TranscriptEntry[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return []; }
  const entries: TranscriptEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(dir, name);
    let stat;
    try { stat = statSync(p); } catch { continue; }
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(p, "utf8")); }
    catch { continue; }
    if (!isObj(doc)) continue;
    const sess = doc["session"];
    if (!isObj(sess)) continue;
    if (sess["session_id"] !== sessionId) continue;
    entries.push({
      path:     p,
      doc:      doc as Record<string, unknown>,
      mtime_ms: Math.trunc(stat.mtimeMs),
    });
  }
  // Sort by mtime ASC (matches Python `sorted(..., key=mtime)`).
  entries.sort((a, b) => a.mtime_ms - b.mtime_ms);
  return entries;
}

// ---------- per-tool transcript summarizer (mirrors Python branches) ----------

function summarizeTranscript(t: TranscriptEntry): Record<string, unknown> {
  const doc = t.doc;
  const toolName = doc["tool"];
  const summary: Record<string, unknown> = {
    path:     t.path,
    mtime_ms: t.mtime_ms,
    tool:     toolName ?? null,
  };
  if (toolName === "confer" || toolName === "review") {
    summary["question"] = String(doc["question"] ?? "").slice(0, 240);
    const answers = (doc["answers"] as unknown[] | undefined) ?? [];
    summary["providers"] = answers
      .filter(isObj)
      .map((a) => (a as Record<string, unknown>)["provider"]);
    if (doc["claims"]) {
      summary["claims_count"] = (doc["claims"] as unknown[]).length;
    }
  } else if (toolName === "debate") {
    summary["topic"]            = String(doc["topic"] ?? "").slice(0, 240);
    summary["rounds_completed"] = doc["rounds_completed"];
    if (doc["claims"]) {
      summary["claims_count"] = (doc["claims"] as unknown[]).length;
    }
  } else if (toolName === "audit") {
    summary["mode"]          = doc["mode"];
    summary["overall_score"] = doc["overall_score"];
    summary["passed"]        = doc["passed"];
    if (Array.isArray(doc["obvious_failures"])) {
      summary["obvious_failures"] = doc["obvious_failures"];
    }
    if (Array.isArray(doc["disagreements"])) {
      summary["disagreements"] = doc["disagreements"];
    }
  } else if (toolName === "orchestrate") {
    const nodes = (doc["nodes"] as unknown[] | undefined) ?? [];
    summary["nodes_run"]    = nodes.length;
    summary["nodes_ok"]     = nodes.filter(
      (n) => isObj(n) && (n as Record<string, unknown>)["status"] === "ok",
    ).length;
    summary["nodes_failed"] = nodes.filter(
      (n) => isObj(n) && (n as Record<string, unknown>)["status"] === "failed",
    ).length;
    summary["partial"]      = doc["partial"];
    summary["cheap_mode"]   = doc["cheap_mode"];
  } else if (toolName === "create" || toolName === "create_cheap") {
    summary["instruction"]  = String(doc["instruction"] ?? "").slice(0, 240);
    summary["status"]       = doc["status"];
    summary["attempts"]     = doc["attempts"];
  }
  const budget = isObj(doc["budget"]) ? doc["budget"] as Record<string, unknown> : null;
  if (budget) {
    summary["call_cost_usd"] = budget["total_cost_usd"];
    summary["call_wall_ms"]  = budget["wall_used_ms"];
    summary["call_cpu_ms"]   = budget["cpu_used_ms"];
  }
  return summary;
}

// ---------- ASCII tree renderer ----------

function renderAsciiTree(
  sessionId: string,
  totals:    {
    calls: number; wall_ms: number; cpu_ms: number;
    total_tokens: number; total_cost_usd: number;
  },
  rows: readonly UsageLogRow[],
): string {
  const lines: string[] = [];
  lines.push(
    `session: ${sessionId}   (${totals.calls} calls, ` +
    `${formatThousands(totals.total_tokens)} tokens, ` +
    `$${formatFloat(totals.total_cost_usd, 4)}, ` +
    `${formatFloat(totals.wall_ms / 1000, 1)}s wall, ` +
    `${formatFloat(totals.cpu_ms / 1000, 3)}s cpu)`,
  );
  // Group rows by tool in insertion order.
  const rowsByTool = new Map<string | null, UsageLogRow[]>();
  const toolOrder:  (string | null)[] = [];
  for (const r of rows) {
    const t = r.tool ?? null;
    if (!rowsByTool.has(t)) {
      rowsByTool.set(t, []);
      toolOrder.push(t);
    }
    rowsByTool.get(t)!.push(r);
  }
  for (let i = 0; i < toolOrder.length; i++) {
    const t = toolOrder[i]!;
    const toolRows = rowsByTool.get(t)!;
    const branch = i === toolOrder.length - 1 ? "`-" : "|-";
    const toolLabel = t ?? "(uncategorized)";
    const toolCost = round6(toolRows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0));
    const toolTok  = toolRows.reduce((s, r) => s + int(r.total_tokens), 0);
    const toolWall = toolRows.reduce((s, r) => s + int(r.wall_ms), 0);
    const toolCpu  = toolRows.reduce((s, r) => s + int(r.cpu_ms), 0);
    lines.push(
      `  ${branch} ${padRight(toolLabel, 14)} ${padLeft(String(toolRows.length), 3)} calls   ` +
      `${padLeft(formatThousands(toolTok), 7)} tok   $${padLeft(formatFloat(toolCost, 4), 8)}   ` +
      `${padLeft(formatFloat(toolWall / 1000, 1), 6)}s wall   ${padLeft(formatFloat(toolCpu / 1000, 3), 6)}s cpu`,
    );
    for (let j = 0; j < toolRows.length; j++) {
      const r = toolRows[j]!;
      const sub = j === toolRows.length - 1 ? "`-" : "|-";
      lines.push(
        `       ${sub} ${r.provider ?? "?"}:${r.model ?? "?"}  ` +
        `purpose=${r.purpose}  ` +
        `${padLeft(formatThousands(int(r.total_tokens)), 5)} tok   ` +
        `$${padLeft(formatFloat(Number(r.cost_usd ?? 0), 5), 8)}   ` +
        `${formatFloat(int(r.wall_ms) / 1000, 2)}s wall   ` +
        `${formatFloat(int(r.cpu_ms) / 1000, 3)}s cpu`,
      );
    }
  }
  return lines.join("\n");
}

// ---------- formatting helpers (Python's f-string equivalents) ----------

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function formatFloat(x: number, decimals: number): string {
  // Use Python-like rounding (banker's). Approximation for non-half
  // values matches the standard .toFixed() rounding which is close
  // enough — most values in this surface aren't on the half boundary.
  return x.toFixed(decimals);
}
function formatThousands(n: number): string {
  // Python's `f"{n:,}"` uses comma as thousands sep, no decimal.
  // Intl is overkill — direct regex is fast + matches.
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function round6(x: number): number { return roundHalfEven(x, 6); }
function round8(x: number): number { return roundHalfEven(x, 8); }
function roundHalfEven(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** decimals;
  const scaled = x * f;
  const floor  = Math.floor(scaled);
  const diff   = scaled - floor;
  let rounded: number;
  if (diff > 0.5)      rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else                 rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / f;
}

// ---------- misc ----------

function boolArg(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null) return defaultVal;
  return Boolean(v);
}
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const hasSingle = v.indexOf("'") >= 0;
    const hasDouble = v.indexOf('"') >= 0;
    const q = hasSingle && !hasDouble ? '"' : "'";
    let out = q;
    for (const ch of v) {
      if (ch === q) out += "\\" + ch;
      else if (ch === "\\") out += "\\\\";
      else out += ch;
    }
    return out + q;
  }
  return String(v);
}

async function deferExplain(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("explain", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "EXPLAIN_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for explain",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
  kind = "client",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tool:          "explain",
    error:         message,
    error_code:    code,
    error_kind:    kind,
    operator_hint: hint,
    transient:     false,
    ...extra,
  };
}
