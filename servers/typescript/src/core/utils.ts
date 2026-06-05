// Small utility helpers — the remaining pure-function corners of the
// Python server that don't fit elsewhere.
//
// Each one mirrors a `_helper` from `servers/python/crosscheck_server.py`:
//   - safeSessionId       (`_safe_session_id`)
//   - perCallTokens       (`_per_call_tokens`)
//   - classifyHttpError   (`_classify_http_error`) — error-kind mapping only
//   - checkSessionBreakers (`_check_session_breakers`)
//   - checkDagBreakers    (`_check_dag_breakers`)
//   - projectSessionWithAnswers (`_project_session_with_answers`)
//
// All byte-equal against the Python originals via the parity fixture set.

// ----------------------------------------------------------------------
// safeSessionId — strip everything outside [A-Za-z0-9._-], cap at 64 chars,
// fall back to "default" when empty.
// ----------------------------------------------------------------------

const SESSION_ID_RE = /[^A-Za-z0-9._-]/g;

/** Sanitize a caller-supplied session id. Mirrors `_safe_session_id`. */
export function safeSessionId(sessionId: string): string {
  const cleaned = (sessionId ?? "").replace(SESSION_ID_RE, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "default";
}

// ----------------------------------------------------------------------
// perCallTokens — split CFG.token_cap evenly across N expected calls,
// with a 256-token floor.
// ----------------------------------------------------------------------

export interface PerCallTokensCfg {
  token_cap?: unknown;
}

/** `max(256, floor(token_cap / max(1, total_calls)))`. Mirrors
 *  `_per_call_tokens`. Reads CFG.token_cap (default 8000) when no
 *  override is supplied. */
export function perCallTokens(totalCalls: number, cfg?: PerCallTokensCfg): number {
  const calls = Math.max(1, Math.trunc(totalCalls));
  const rawCap = cfg?.token_cap;
  const cap = typeof rawCap === "number" && Number.isFinite(rawCap)
    ? Math.trunc(rawCap)
    : 8000;
  return Math.max(256, Math.trunc(cap / calls));
}

// ----------------------------------------------------------------------
// classifyHttpError — map an HTTP status code to (kind, transient) per
// the Python `_classify_http_error` rules.
// ----------------------------------------------------------------------

export type HttpErrorKind = "auth" | "rate_limit" | "server" | "client";

export interface ClassifiedHttpError {
  kind: HttpErrorKind;
  transient: boolean;
  status: number;
  message: string;
  /** Float seconds from a `Retry-After` header, or null when missing/unparseable. */
  retry_after_s: number | null;
}

/** Pure-function classifier: take a status code + body + optional
 *  Retry-After header, return the structured error description. The
 *  Python helper reads everything off a `urllib.error.HTTPError`; here
 *  we accept the parts directly so the caller can pass whatever the
 *  TS HTTP layer surfaces. */
export function classifyHttpError(input: {
  status: number;
  body?: string;
  retryAfterHeader?: string | null;
}): ClassifiedHttpError {
  const body = input.body ?? "";
  const msg = `HTTP ${input.status}: ${body.slice(0, 512)}`;
  let retryAfter: number | null = null;
  if (input.retryAfterHeader) {
    const v = Number(input.retryAfterHeader);
    if (Number.isFinite(v)) retryAfter = v;
  }
  const status = input.status;
  if (status === 401 || status === 403) {
    return { kind: "auth", transient: false, status, message: msg, retry_after_s: retryAfter };
  }
  if (status === 429) {
    return { kind: "rate_limit", transient: true, status, message: msg, retry_after_s: retryAfter };
  }
  if (status >= 500 && status <= 599) {
    return { kind: "server", transient: true, status, message: msg, retry_after_s: retryAfter };
  }
  return { kind: "client", transient: false, status, message: msg, retry_after_s: retryAfter };
}

// ----------------------------------------------------------------------
// Session breakers — pure-function checks against a session row.
// ----------------------------------------------------------------------

export interface SessionRowSnapshot {
  session_id?: string;
  total_cost_usd?: number;
  total_tokens?: number;
  wall_ms?: number;
}

export interface BreakerCfg {
  max_session_cost_usd?: number;
  max_session_tokens?: number;
  max_session_wall_seconds?: number;
  max_dag_nodes?: number;
  max_dag_depth?: number;
}

export interface BreakerTrip {
  name: string;
  reason: string;
}

/** Check session-scoped breakers. Returns `null` when no breaker tripped.
 *  Mirrors `_check_session_breakers` byte-for-byte (cost-first, then
 *  tokens, then wall). */
export function checkSessionBreakers(
  session: SessionRowSnapshot | null | undefined,
  cfg: BreakerCfg | undefined,
): BreakerTrip | null {
  if (!session || typeof session !== "object") return null;
  const c = cfg ?? {};
  const costCap = Number(c.max_session_cost_usd ?? 0);
  if (costCap > 0 && Number(session.total_cost_usd ?? 0) >= costCap) {
    return {
      name: "max_session_cost_usd",
      reason:
        `session cost $${Number(session.total_cost_usd ?? 0).toFixed(4)} ` +
        `>= cap $${costCap.toFixed(4)}`,
    };
  }
  const tokCap = Math.trunc(Number(c.max_session_tokens ?? 0));
  if (tokCap > 0 && Math.trunc(Number(session.total_tokens ?? 0)) >= tokCap) {
    return {
      name: "max_session_tokens",
      reason: `session tokens ${Math.trunc(Number(session.total_tokens ?? 0))} >= cap ${tokCap}`,
    };
  }
  const wallCapS = Math.trunc(Number(c.max_session_wall_seconds ?? 0));
  if (wallCapS > 0 && Math.trunc(Number(session.wall_ms ?? 0)) >= wallCapS * 1000) {
    return {
      name: "max_session_wall_seconds",
      reason:
        `session wall ${Math.trunc(Number(session.wall_ms ?? 0))}ms >= ` +
        `cap ${wallCapS * 1000}ms`,
    };
  }
  return null;
}

// ----------------------------------------------------------------------
// DAG breakers (orchestrate node-count + topological-depth caps).
// ----------------------------------------------------------------------

export interface DagNode {
  id?: string;
  depends_on?: readonly string[];
}

export interface DagShape {
  nodes?: readonly DagNode[];
}

/** Returns `(name, reason)` when DAG breakers trip; null otherwise.
 *  Includes cycle-fail-closed for the depth breaker. */
export function checkDagBreakers(
  dag: DagShape | null | undefined,
  cfg: BreakerCfg | undefined,
): BreakerTrip | null {
  if (!dag || typeof dag !== "object") return null;
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  const c = cfg ?? {};
  const maxNodes = Math.trunc(Number(c.max_dag_nodes ?? 0));
  if (maxNodes > 0 && nodes.length > maxNodes) {
    return {
      name: "max_dag_nodes",
      reason: `dag has ${nodes.length} nodes > cap ${maxNodes}`,
    };
  }
  const maxDepth = Math.trunc(Number(c.max_dag_depth ?? 0));
  if (maxDepth > 0) {
    const deps = new Map<string, readonly string[]>();
    for (const n of nodes) {
      if (n && typeof n === "object" && typeof n.id === "string") {
        deps.set(n.id, Array.isArray(n.depends_on) ? n.depends_on : []);
      }
    }
    const memo = new Map<string, number>();
    let cycleAt: string | null = null;
    const depth = (nid: string, stack: ReadonlySet<string>): number => {
      const cached = memo.get(nid);
      if (cached !== undefined) return cached;
      if (stack.has(nid)) {
        cycleAt = nid;
        throw new Error("cycle");
      }
      const ds = deps.get(nid) ?? [];
      let best = 0;
      const nextStack = new Set(stack);
      nextStack.add(nid);
      for (const p of ds) {
        const d = depth(p, nextStack);
        if (d > best) best = d;
      }
      const result = 1 + best;
      memo.set(nid, result);
      return result;
    };
    let computed = 0;
    try {
      for (const n of nodes) {
        if (n && typeof n === "object" && typeof n.id === "string") {
          const d = depth(n.id, new Set());
          if (d > computed) computed = d;
        }
      }
    } catch {
      return {
        name: "max_dag_depth",
        reason:
          `cycle detected at node ${cycleAt}; depth can't be bounded — ` +
          "fail-closed (this normally means _validate_dag missed it)",
      };
    }
    if (computed > maxDepth) {
      return {
        name: "max_dag_depth",
        reason: `dag depth ${computed} > cap ${maxDepth}`,
      };
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// projectSessionWithAnswers — forward-project a session row with the
// usage of in-flight answers that haven't been written to usage_log yet.
// ----------------------------------------------------------------------

export interface AnswerSnapshot {
  usage?: { cost_usd?: number; total_tokens?: number };
  elapsed_ms?: number;
}

/** Mirrors `_project_session_with_answers`. Returns `null` when
 *  `session` is null/undefined (so the caller can chain). */
export function projectSessionWithAnswers(
  session: SessionRowSnapshot | null | undefined,
  extraAnswers: readonly AnswerSnapshot[] | null | undefined,
): SessionRowSnapshot | null {
  if (!session || typeof session !== "object") return null;
  const projected: SessionRowSnapshot = { ...session };
  for (const a of extraAnswers ?? []) {
    const u = a?.usage ?? {};
    projected.total_cost_usd =
      Number(projected.total_cost_usd ?? 0) + Number(u.cost_usd ?? 0);
    projected.total_tokens =
      Math.trunc(Number(projected.total_tokens ?? 0)) +
      Math.trunc(Number(u.total_tokens ?? 0));
    projected.wall_ms =
      Math.trunc(Number(projected.wall_ms ?? 0)) +
      Math.trunc(Number(a?.elapsed_ms ?? 0));
  }
  return projected;
}
