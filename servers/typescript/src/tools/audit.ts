// Native TS port of Python's `tool_audit` — Phase 5 part 4.
//
// SCOPE for v1 (single-mode only):
//   - Picks ONE auditor (explicit name → moderator default → first
//     available, all minus the `producing_panelists` exclude list).
//   - Sends one LLM call with the audit rubric (default 6-item list
//     or caller-supplied override).
//   - Validates against _audit_rubric_schema; aggregates items into
//     {score, pass, rationale} per rubric id; computes overall_score
//     as mean(scores) when the model omits it; computes `passed` as
//     all-items-pass.
//   - Output envelope mirrors Python's single-mode shape (sans
//     budget/session/usage/timing/run_summary tail fields — strip
//     symmetrically in parity).
//
// OUT OF SCOPE for v1 (defer to bridge if available):
//   - coalesce mode (multi-judge consensus + disagreement detection)
//   - cheap_mode tier-aware auditor picker (just defaults to
//     moderator → first provider in v1; explicit `auditor` is the
//     escape hatch)
//   - _latest_transcript_for_session — caller must pass
//     `output_to_audit` directly; session-id-only mode defers
//   - _session_memory_mark_stale anti-poisoning gate
//   - write_transcript on-disk archive
//   - log_usage / claim_add / _attach_usage_block tail

import { requestStructured, type AskAnswer } from "../core/structured.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { Provider, ChatMessage } from "../providers/types.js";

/** A single rubric item. Stable shape across the input/output cycle. */
export interface RubricItem {
  id:          string;
  description: string;
  severity:    string;
}

/** Default audit rubric. Byte-identical to Python's DEFAULT_AUDIT_RUBRICS. */
export const DEFAULT_AUDIT_RUBRICS: readonly RubricItem[] = [
  { id: "factual_grounding",
    description:
      "Claims are grounded in evidence, sources, or stated assumptions; " +
      "no hallucinated facts or APIs.",
    severity: "high" },
  { id: "constraint_adherence",
    description:
      "Output respects all stated user constraints (scope, language, format, budget).",
    severity: "high" },
  { id: "no_pii_leak",
    description:
      "Output does not echo or leak emails, secrets, API keys, IPs, or other " +
      "personally identifying data.",
    severity: "high" },
  { id: "internally_consistent",
    description:
      "Output is internally consistent; later statements do not contradict earlier ones.",
    severity: "med" },
  { id: "covers_open_questions",
    description:
      "Identifies and surfaces open questions or unresolved trade-offs instead " +
      "of papering over them.",
    severity: "med" },
  { id: "actionability",
    description:
      "Output is concrete and actionable for the stated audience; not vague hand-waving.",
    severity: "low" },
];

/** Audit rubric JSON schema — inlined from Python _audit_rubric_schema. */
const AUDIT_RUBRIC_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:        { type: "string" },
          score:     { type: "number" },
          pass:      { type: "boolean" },
          rationale: { type: "string" },
        },
        required: ["id", "score", "pass", "rationale"],
      },
    },
    overall_score: { type: "number" },
  },
  required: ["items"],
};

/** Run the audit tool natively. */
export interface RunAuditOptions {
  providers:        Readonly<Record<string, Provider>>;
  moderator?:       string;             // default "anthropic" (matches Python CFG)
  bridge?:          BridgeHandle;       // for coalesce-mode deferral
  allowlist?:       readonly string[] | null;
}

/** Native run. Mirrors Python tool_audit (single-mode branch). */
export async function runAudit(
  args: Record<string, unknown>,
  opts: RunAuditOptions,
): Promise<Record<string, unknown>> {
  const outputToAudit = args["output_to_audit"];
  const sessionId     = args["session_id"];
  const rubricOverride = args["rubric"];
  const producing     = toStringArray(args["producing_panelists"]).map((s) => s.toLowerCase());
  const explicit      = typeof args["auditor"] === "string" ? args["auditor"] : null;
  const cheapMode     = boolArg(args["cheap_mode"], true);
  const allowSelf     = boolArg(args["allow_self_audit"], false);
  const coalesce      = boolArg(args["coalesce"], false);
  const strictMode    = boolArg(args["strict_mode"], false);
  const userConstraints = typeof args["constraints"] === "string"
    ? args["constraints"] : "";

  // v1 input gates.
  if (typeof outputToAudit !== "string" || outputToAudit === "") {
    if (sessionId) {
      // Python pulls the latest transcript and re-runs from that. Not
      // ported in v1 — defer to bridge or surface a clear error.
      if (opts.bridge && opts.bridge.toolNames.has("audit")) {
        return await deferAudit(args, opts.bridge);
      }
      return errorEnvelope(
        "AUDIT_SESSION_LOAD_NOT_NATIVE",
        "session-id-only audit requires bridge mode in v1; pass `output_to_audit` " +
          "directly to use the native path",
        "This is a stub. Will port when session_memory + transcripts land.",
      );
    }
    return errorEnvelope(
      "AUDIT_MISSING_INPUT",
      "must provide `output_to_audit` or `session_id`",
      "Pass the text to grade as `output_to_audit`, or a `session_id` whose " +
        "latest transcript will be auto-extracted.",
    );
  }

  // coalesce defers to bridge in v1.
  if (coalesce) {
    if (opts.bridge && opts.bridge.toolNames.has("audit")) {
      return await deferAudit(args, opts.bridge);
    }
    return errorEnvelope(
      "AUDIT_COALESCE_NOT_NATIVE",
      "coalesce-mode audit requires bridge mode in v1",
      "Single-mode (coalesce=false, the default) IS native. Set " +
        "CROSSCHECK_BRIDGE_PYTHON=1 to enable coalesce.",
    );
  }

  // Build rubric (validated override → defaults).
  const rubricItems: RubricItem[] = [];
  if (Array.isArray(rubricOverride) && rubricOverride.length > 0) {
    for (const r of rubricOverride) {
      if (isObj(r) && "id" in r && "description" in r) {
        rubricItems.push({
          id:          String(r["id"]),
          description: String(r["description"]),
          severity:    String(r["severity"] ?? "med"),
        });
      }
    }
  }
  if (rubricItems.length === 0) {
    for (const r of DEFAULT_AUDIT_RUBRICS) rubricItems.push({ ...r });
  }

  // Pick auditor (simplified v1 logic — see file header).
  const exclude = allowSelf ? new Set<string>() : new Set(producing);
  const { auditor, reason } = pickAuditor(
    opts.providers, exclude, explicit,
    opts.moderator ?? "anthropic",
    opts.allowlist ?? null,
  );
  if (auditor === null) {
    return errorEnvelope(
      "AUDIT_NO_AUDITOR",
      reason ?? "no auditor available",
      "Set ANTHROPIC_API_KEY or another provider in .env, or " +
        "set `allow_self_audit=true` to permit the producing panel " +
        "to self-grade.",
    );
  }

  // Build messages — byte-equal with Python's f"…" interpolations.
  const rubricText = rubricItems
    .map((it) => `- ${it.id} (severity=${it.severity}): ${it.description}`)
    .join("\n");
  const sysMsg =
    "You are an independent auditor. Score the OUTPUT against each rubric " +
    "item on a 0..1 likelihood that the rubric is satisfied. Set pass=true " +
    "iff score >= 0.7. Be concise in `rationale` (1-2 sentences each).";
  const userMsg =
    (userConstraints ? `USER CONSTRAINTS:\n${userConstraints}\n\n` : "") +
    `OUTPUT TO AUDIT:\n${outputToAudit}\n\n` +
    `RUBRIC ITEMS:\n${rubricText}`;

  const msgs: ChatMessage[] = [
    { role: "system", content: sysMsg },
    { role: "user",   content: userMsg },
  ];

  // Single LLM call — schema validated + 1 retry.
  const r = await requestStructured(auditor, msgs, AUDIT_RUBRIC_SCHEMA, {
    maxTokens: 2048, maxRetries: 1, purpose: "audit",
  });
  const obj   = r.obj as { items?: unknown[]; overall_score?: unknown } | null;
  const rawAns = r.answer;
  const errs   = r.errors;
  void cheapMode;  // accepted-but-unused in v1

  // Aggregate items into the canonical shape, defaulting missing ids.
  const itemsWithMeta: {
    id:          string;
    description: string;
    severity:    string;
    score:       number;
    pass:        boolean;
    rationale:   string;
  }[] = [];
  let overall: number | null = null;
  if (obj && Array.isArray(obj.items)) {
    const byId: Record<string, Record<string, unknown>> = {};
    for (const it of obj.items) {
      if (isObj(it) && typeof it["id"] === "string") byId[it["id"]] = it;
    }
    for (const ri of rubricItems) {
      const scored = byId[ri.id] ?? { score: 0.0, pass: false,
                                       rationale: "(no rationale)" };
      itemsWithMeta.push({
        id:          ri.id,
        description: ri.description,
        severity:    ri.severity,
        score:       Number(scored["score"] ?? 0.0),
        pass:        Boolean(scored["pass"] ?? false),
        rationale:   String(scored["rationale"] ?? ""),
      });
    }
    overall = typeof obj.overall_score === "number" ? obj.overall_score : null;
    if (overall === null && itemsWithMeta.length > 0) {
      overall = itemsWithMeta.reduce((s, it) => s + it.score, 0) / itemsWithMeta.length;
    }
  }

  const allPass = itemsWithMeta.length > 0 && itemsWithMeta.every((it) => it.pass);

  const result: Record<string, unknown> = {
    tool:           "audit",
    mode:           "single",
    strict_mode:    strictMode,
    auditor:        { provider: auditor.name, model: auditor.model },
    rubric:         rubricItems,
    items:          itemsWithMeta,
    overall_score:  overall,
    passed:         allPass,
  };
  if (errs.length > 0) result["validation_errors"] = errs;

  // Suppress unused-warning on the (kept-for-future) variables.
  void rawAns; void sessionId;

  return result;
}

interface PickAuditorResult { auditor: Provider | null; reason: string | null }

/** Simplified port of `_select_auditor`. v1 skips the cheap-mode tier
 *  picker (which would need pricing + tier ladder threading). Order:
 *    explicit > moderator > first available not in exclude */
function pickAuditor(
  providers: Readonly<Record<string, Provider>>,
  exclude:   ReadonlySet<string>,
  explicit:  string | null,
  moderatorName: string,
  allowlist: readonly string[] | null,
): PickAuditorResult {
  if (explicit) {
    const key = explicit.toLowerCase();
    const p = providers[key];
    if (p === undefined) {
      return { auditor: null, reason: `explicit auditor '${explicit}' is not configured` };
    }
    if (exclude.has(p.name)) {
      return { auditor: null, reason:
        `explicit auditor '${explicit}' is in the producing panel; pick a different auditor or omit \`auditor\`` };
    }
    if (allowlist !== null && !allowlist.includes(p.name)) {
      return { auditor: null, reason:
        `explicit auditor '${explicit}' is blocked by allowlist` };
    }
    return { auditor: p, reason: null };
  }
  // Moderator preference.
  const mod = providers[moderatorName.toLowerCase()];
  if (mod !== undefined
      && !exclude.has(mod.name)
      && (allowlist === null || allowlist.includes(mod.name))) {
    return { auditor: mod, reason: null };
  }
  // First available not in exclude.
  for (const [, p] of Object.entries(providers)) {
    if (exclude.has(p.name)) continue;
    if (allowlist !== null && !allowlist.includes(p.name)) continue;
    return { auditor: p, reason: null };
  }
  return { auditor: null, reason:
    "no auditor available — every registered provider was on the producing panel; " +
    "widen the panel or set `allow_self_audit=true`" };
}

async function deferAudit(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("audit", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "AUDIT_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for audit",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(code: string, message: string, hint: string): Record<string, unknown> {
  return {
    tool:          "audit",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function boolArg(v: unknown, defaultVal: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null) return defaultVal;
  return Boolean(v);
}

// For tests.
export const __test_internals = {
  AUDIT_RUBRIC_SCHEMA,
  pickAuditor,
};

// Keep the AskAnswer import live for downstream consumers.
void (null as unknown as AskAnswer);
