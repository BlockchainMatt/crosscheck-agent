// Native TS port of Python's `tool_delegate` — Phase 5 part 19.
//
// Quota-gated single-provider dispatch to confer / review. Validates
// the call shape (tool name in allowlist, provider configured, not
// blocked by allowlist), checks quota (accepted-only counts against
// per-session + per-requester limits), then forwards the inner call
// with `providers: [via]` forced — so the named provider is the only
// one consulted.
//
// Records every attempt (accepted or refused) into the delegations
// table. The quota for the response is recomputed AFTER recording so
// the caller sees the count INCLUDING the current call.

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage } from "../adapters/storage/interface.js";
import type { Provider } from "../providers/types.js";

import { runConfer } from "./confer.js";
import { runReview } from "./review.js";

const DELEGABLE_TOOLS: ReadonlySet<string> = new Set(["confer", "review"]);

/** Default limits — match Python CFG.delegation defaults. */
export const DEFAULT_DELEGATION_LIMITS = {
  max_per_session:   50,
  max_per_requester: 200,
} as const;

export interface DelegationLimits {
  max_per_session:   number;
  max_per_requester: number;
}

export interface RunDelegateOptions {
  /** Available providers (LLM dispatch target). */
  providers:        Readonly<Record<string, Provider>>;
  /** Optional provider allowlist for the dispatch check. */
  allowlist?:       readonly string[] | null;
  /** Storage adapter — used for quota counts + delegation record
   *  inserts. Required for delegate to function (else defer/error). */
  storage?:         Storage;
  bridge?:          BridgeHandle;
  /** Per-session + per-requester quota ceilings. Defaults to the
   *  Python CFG.delegation defaults (50 / 200). */
  limits?:          DelegationLimits;
  /** Epoch seconds for the delegation row's created_at field. */
  nowEpochSeconds?: () => number;
  /** Moderator default for inner confer/review (threaded through). */
  moderator?:       string;
}

export async function runDelegate(
  args: Record<string, unknown>,
  opts: RunDelegateOptions,
): Promise<Record<string, unknown>> {
  // Storage not wired → defer to bridge or error.
  if (!opts.storage) {
    if (opts.bridge && opts.bridge.toolNames.has("delegate")) {
      return await deferDelegate(args, opts.bridge);
    }
    return errorEnvelope(
      "DELEGATE_STORAGE_NOT_NATIVE",
      "delegate requires a wired Storage adapter (for quota) or the Python bridge",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to use the Python implementation, " +
        "or wire a Storage adapter into the entrypoint.",
    );
  }
  const storage = opts.storage;
  const limits  = opts.limits ?? DEFAULT_DELEGATION_LIMITS;

  const toolCall  = String(args["tool_call"] ?? "");
  const via       = String(args["via"]       ?? "");
  const innerRaw  = args["args"];
  const innerArgs = (innerRaw && typeof innerRaw === "object" && !Array.isArray(innerRaw))
    ? { ...(innerRaw as Record<string, unknown>) }
    : {};
  const requester = typeof args["requested_by"] === "string" ? args["requested_by"] : null;
  const sessionId = typeof args["session_id"]    === "string" ? args["session_id"]    : null;
  const now       = opts.nowEpochSeconds ? opts.nowEpochSeconds() : Math.floor(Date.now() / 1000);

  // Initial (pre-attempt) quota snapshot.
  const usedSession   = sessionId ? await storage.countAcceptedDelegationsBySession(sessionId)     : 0;
  const usedRequester = requester ? await storage.countAcceptedDelegationsByRequester(requester) : 0;
  const quota = {
    session_used:        usedSession,
    session_limit:       limits.max_per_session,
    session_remaining:   Math.max(0, limits.max_per_session - usedSession),
    requester_used:      usedRequester,
    requester_limit:     limits.max_per_requester,
    requester_remaining: Math.max(0, limits.max_per_requester - usedRequester),
  };
  const baseEnvelope = {
    tool: "delegate",
    tool_call: toolCall,
    via,
    requested_by: requester,
    quota,
  };

  // Validate the call shape before honouring.
  if (!DELEGABLE_TOOLS.has(toolCall)) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return {
      ...baseEnvelope, accepted: false,
      reason: `tool ${pyRepr(toolCall)} is not delegable; allowed: ${pyListRepr([...DELEGABLE_TOOLS])}`,
    };
  }
  if (!opts.providers[via]) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return {
      ...baseEnvelope, accepted: false,
      reason: `provider ${pyRepr(via)} is not configured (no API key in .env or unknown)`,
    };
  }
  if (opts.allowlist !== null && opts.allowlist !== undefined && !opts.allowlist.includes(via)) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return {
      ...baseEnvelope, accepted: false,
      reason: `provider ${pyRepr(via)} is blocked by provider_allowlist`,
    };
  }

  // Quota check.
  if (usedSession >= limits.max_per_session && sessionId) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return { ...baseEnvelope, accepted: false, reason: "quota_exhausted_for_session" };
  }
  if (usedRequester >= limits.max_per_requester && requester) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return { ...baseEnvelope, accepted: false, reason: "quota_exhausted_for_requester" };
  }

  // Force the inner call onto the named provider.
  innerArgs["providers"] = [via];
  if (sessionId && innerArgs["session_id"] === undefined) {
    innerArgs["session_id"] = sessionId;
  }

  // Dispatch to the native inner tool.
  const innerOpts = {
    providers: opts.providers,
    allowlist: opts.allowlist ?? null,
    ...(opts.bridge    ? { bridge:    opts.bridge }    : {}),
    ...(opts.moderator ? { moderator: opts.moderator } : {}),
  };
  let result: Record<string, unknown>;
  try {
    if (toolCall === "confer")      result = await runConfer(innerArgs, innerOpts);
    else if (toolCall === "review") result = await runReview(innerArgs, innerOpts);
    else throw new Error(`unreachable: ${toolCall}`);
  } catch (e) {
    await record(storage, sessionId, requester, toolCall, via, false, now);
    return {
      ...baseEnvelope, accepted: false,
      reason: `delegate failed: ${(e as Error).message ?? String(e)}`,
    };
  }

  // Record the successful attempt, then recompute the quota so the
  // caller sees counts INCLUDING this call.
  await record(storage, sessionId, requester, toolCall, via, true, now);
  const usedSession2   = sessionId ? await storage.countAcceptedDelegationsBySession(sessionId)     : 0;
  const usedRequester2 = requester ? await storage.countAcceptedDelegationsByRequester(requester) : 0;
  const quotaAfter = {
    session_used:        usedSession2,
    session_limit:       limits.max_per_session,
    session_remaining:   Math.max(0, limits.max_per_session - usedSession2),
    requester_used:      usedRequester2,
    requester_limit:     limits.max_per_requester,
    requester_remaining: Math.max(0, limits.max_per_requester - usedRequester2),
  };
  return { ...baseEnvelope, accepted: true, result, quota: quotaAfter };
}

async function record(
  storage: Storage,
  sessionId: string | null,
  requester: string | null,
  toolCall: string,
  via: string,
  accepted: boolean,
  nowEpochSeconds: number,
): Promise<void> {
  await storage.insertDelegation({
    session_id: sessionId,
    requester,
    tool_call: toolCall,
    via,
    accepted: accepted ? 1 : 0,
    created_at: nowEpochSeconds,
  });
}

async function deferDelegate(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("delegate", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "DELEGATE_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for delegate",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string,
): Record<string, unknown> {
  return {
    tool:          "delegate",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

/** Python repr for embedding in error strings. */
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

function pyListRepr(xs: readonly string[]): string {
  return "[" + xs.map((s) => pyRepr(s)).join(", ") + "]";
}

export const __test_internals = { DELEGABLE_TOOLS };
