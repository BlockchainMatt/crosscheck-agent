// Native TS port of Python's `tool_recall` — Phase 5 part 14.
//
// First storage-driven tool ported. Uses Storage.recallSearch() which
// the better-sqlite3 adapter implements via SQLite FTS5 with bm25
// ranking + snippet windowing.
//
// SCOPE for v1:
//   - Full-text search over the transcripts_fts virtual table.
//   - Filters: session_id, tool, since_days.
//   - Output: {tool, rows[], count, applied_filters}.
//   - When Storage isn't provided (entrypoint without --db), defers
//     to the Python bridge if available; else returns a clear error.

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage } from "../adapters/storage/interface.js";

export interface RunRecallOptions {
  /** SQLite-backed storage adapter. When absent we defer to the
   *  bridge (or error if no bridge is wired). */
  storage?: Storage;
  bridge?:  BridgeHandle;
  /** Synthetic "now" in seconds — lets parity tests pin since_days
   *  filters deterministically. Defaults to Date.now()/1000. */
  nowEpochSeconds?: () => number;
}

export async function runRecall(
  args: Record<string, unknown>,
  opts: RunRecallOptions,
): Promise<Record<string, unknown>> {
  const queryRaw = args["query"];
  const query = typeof queryRaw === "string" ? queryRaw.trim() : "";
  if (query === "") {
    return errorEnvelope(
      "RECALL_MISSING_QUERY",
      "must provide a non-empty `query` string",
      "Free text works; phrase-quote with double quotes, combine with " +
        "AND / OR / NOT (FTS5 syntax).",
    );
  }

  const kRaw = args["k"] === undefined ? 5 : Number(args["k"]);
  let k = Number.isFinite(kRaw) ? Math.trunc(kRaw) : 5;
  if (k < 1) k = 1;
  if (k > 50) k = 50;

  // Storage not wired → defer to bridge or error.
  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("recall")) {
      return await deferRecall(args, opts.bridge);
    }
    return errorEnvelope(
      "RECALL_STORAGE_NOT_NATIVE",
      "recall requires a wired Storage adapter or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }

  // Match the Storage interface field names (session_id, since_ms).
  const filter: { session_id?: string; tool?: string; since_ms?: number } = {};
  const applied: Record<string, unknown> = { query, k };

  if (typeof args["session_id"] === "string" && args["session_id"]) {
    filter.session_id = args["session_id"];
    applied["session_id"] = args["session_id"];
  }
  if (typeof args["tool"] === "string" && args["tool"]) {
    filter.tool = args["tool"];
    applied["tool"] = args["tool"];
  }
  const sinceDaysRaw = args["since_days"];
  if (typeof sinceDaysRaw === "number" && sinceDaysRaw > 0) {
    const now = opts.nowEpochSeconds ? opts.nowEpochSeconds() : Date.now() / 1000;
    filter.since_ms = Math.trunc((now - sinceDaysRaw * 86400) * 1000);
    applied["since_days"] = sinceDaysRaw;
  }

  let hits;
  try {
    hits = await opts.storage.recallSearch(query, k, filter);
  } catch (e) {
    return {
      ...errorEnvelope(
        "RECALL_QUERY_INVALID",
        `FTS5 query rejected: ${(e as Error).message ?? String(e)}`,
        "Check FTS5 MATCH syntax: phrase-quote with double quotes; " +
          "use AND / OR / NOT; escape special characters.",
      ),
      rows: [],
      count: 0,
      applied_filters: { query, k },
    };
  }

  const rows = hits.map((h) => ({
    session_id: h.session_id ?? "",
    tool:       h.tool       ?? "",
    ts:         Math.trunc(Number(h.ts) || 0),
    path:       h.path       ?? "",
    snippet:    h.snippet    ?? "",
    score:      Number(h.score) || 0.0,
  }));

  return {
    tool:            "recall",
    rows,
    count:           rows.length,
    applied_filters: applied,
  };
}

async function deferRecall(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("recall", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "RECALL_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for recall",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
): Record<string, unknown> {
  return {
    tool:          "recall",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}
