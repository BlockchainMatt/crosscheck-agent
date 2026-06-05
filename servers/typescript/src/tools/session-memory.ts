// Native TS port of Python's `tool_session_memory` — Phase 5 part 15.
//
// CRUD over the per-session working memory ledger. Four actions:
//   list        — return rows (kind/content/stale filter, with limit)
//   add         — insert a row, return the new id
//   mark_stale  — flag rows as stale (by ids and/or kinds), return count
//   clear       — delete all rows for the session, return deleted count

import type { BridgeHandle } from "../bridge/index.js";
import type {
  Storage,
  SessionMemoryKind,
} from "../adapters/storage/interface.js";

const VALID_KINDS: ReadonlySet<string> = new Set([
  "fact", "open_question", "decision",
]);

/** Default page size for `list`. Matches Python _SESSION_MEMORY_DEFAULT_LIMIT. */
const DEFAULT_LIMIT = 50;

export interface RunSessionMemoryOptions {
  storage?: Storage;
  bridge?:  BridgeHandle;
  /** Epoch ms used as "now" for inserts + mark_stale events.
   *  Tests inject a fixed value for deterministic timestamps. */
  nowMs?: () => number;
}

export async function runSessionMemory(
  args: Record<string, unknown>,
  opts: RunSessionMemoryOptions,
): Promise<Record<string, unknown>> {
  const action = args["action"];
  if (action !== "list" && action !== "add"
      && action !== "mark_stale" && action !== "clear") {
    return errorEnvelope(
      "SESSION_MEMORY_BAD_ACTION",
      `unknown action ${pyRepr(action)}`,
      "action must be one of: list, add, mark_stale, clear.",
    );
  }

  const sessionId = args["session_id"];
  if (typeof sessionId !== "string" || sessionId === "") {
    return errorEnvelope(
      "SESSION_MEMORY_MISSING_SESSION_ID",
      "session_id is required",
      "Pass the session_id whose memory you want to read/edit.",
    );
  }

  // Storage not wired → defer to bridge or error.
  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("session_memory")) {
      return await deferSessionMemory(args, opts.bridge);
    }
    return errorEnvelope(
      "SESSION_MEMORY_STORAGE_NOT_NATIVE",
      "session_memory requires a wired Storage adapter or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }

  const storage = opts.storage;
  const now = opts.nowMs ? opts.nowMs() : Date.now();

  if (action === "list") {
    const kinds = filterValidKinds(args["kinds"]);
    const includeStale = Boolean(args["include_stale"] ?? false);
    const limit = clampInt(args["limit"], 1, 10_000, DEFAULT_LIMIT);
    const rows = await storage.listSessionMemory(sessionId, {
      ...(kinds ? { kinds } : {}),
      include_stale: includeStale,
      limit,
    });
    return {
      tool:       "session_memory",
      action:     "list",
      session_id: sessionId,
      rows,
      count:      rows.length,
    };
  }

  if (action === "add") {
    const kind = args["kind"];
    const content = args["content"];
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
      return errorEnvelope(
        "SESSION_MEMORY_BAD_KIND",
        `kind must be one of ['fact', 'open_question', 'decision']; got ${pyRepr(kind)}`,
        "Use 'fact', 'open_question', or 'decision'.",
      );
    }
    if (typeof content !== "string" || content.trim() === "") {
      return errorEnvelope(
        "SESSION_MEMORY_EMPTY_CONTENT",
        "content must be a non-empty string",
        "Provide a single concise sentence.",
      );
    }
    try {
      const newId = await storage.insertSessionMemory({
        session_id: sessionId,
        kind:       kind as SessionMemoryKind,
        content,
        source_tool:
          typeof args["source_tool"] === "string" ? args["source_tool"] : null,
        confidence:
          typeof args["confidence"] === "number" ? args["confidence"] : null,
        created_at: now,
      });
      return {
        tool:       "session_memory",
        action:     "add",
        session_id: sessionId,
        id:         newId,
      };
    } catch (e) {
      return errorEnvelope(
        "SESSION_MEMORY_INVALID",
        (e as Error).message ?? String(e),
        "Check kind/content arguments.",
      );
    }
  }

  if (action === "mark_stale") {
    const idsArg = args["ids"];
    const kindsArg = filterValidKinds(args["kinds"]);
    const reason =
      typeof args["reason"] === "string" && args["reason"]
        ? args["reason"]
        : "manual";
    const idsParam = Array.isArray(idsArg)
      ? (idsArg as unknown[])
          .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
      : undefined;
    const markOpts: { ids?: readonly number[]; kinds?: readonly SessionMemoryKind[]; reason?: string } = {
      reason,
    };
    if (idsParam) markOpts.ids = idsParam;
    if (kindsArg) markOpts.kinds = kindsArg;
    const n = await storage.markSessionMemoryStale(sessionId, now, markOpts);
    return {
      tool:         "session_memory",
      action:       "mark_stale",
      session_id:   sessionId,
      marked_stale: n,
    };
  }

  // action === "clear"
  const deleted = await storage.clearSessionMemory(sessionId);
  return {
    tool:       "session_memory",
    action:     "clear",
    session_id: sessionId,
    deleted,
  };
}

// ---------- helpers ----------

function filterValidKinds(v: unknown): readonly SessionMemoryKind[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const valid = v.filter(
    (x): x is SessionMemoryKind =>
      typeof x === "string" && VALID_KINDS.has(x),
  );
  return valid.length > 0 ? valid : undefined;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function deferSessionMemory(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("session_memory", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "SESSION_MEMORY_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for session_memory",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
): Record<string, unknown> {
  return {
    tool:          "session_memory",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

/** Python repr-of-value for embedding in error strings. Match
 *  `f"…{value!r}…"` for the few types that actually flow through. */
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
  if (v === null || v === undefined) return "None";
  if (v === true)  return "True";
  if (v === false) return "False";
  return String(v);
}

export const __test_internals = { VALID_KINDS, DEFAULT_LIMIT };
