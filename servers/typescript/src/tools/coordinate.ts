// Native TS port of Python's `tool_coordinate` — Phase 5 part 8.
//
// SCOPE for v1 (plain three-role orchestration):
//   - ≥ 2 providers required.
//   - Roles: proposer (defaults to selected[0]) → critics (parallel,
//     remaining providers minus proposer + synth) → synthesizer
//     (defaults to opts.moderator || selected[-1]).
//   - Each step uses requestStructured with its own schema:
//       proposer + critics → RoleTurn schema
//       synthesizer        → StructuredSynthesis schema
//   - Result envelope mirrors Python's: roles, proposal_*,
//     critique_*, synthesis_*. Tail fields (budget, session, usage,
//     timing, run_summary, canary_leaks, transcript_path) match the
//     other tools' deferral / strip pattern.
//
// OUT OF SCOPE for v1 — any of these args → defer to bridge:
//   - untrusted_input (canary mint + wrap)
//   - inject_session_memory
//   - worker_tools  (non-empty)
//   - claim_add / session_memory_add are best-effort in Python; we
//     just omit them — parity strips them anyway.
//
// Critics dispatch is sequential in v1 (output bytes don't depend on
// order; parallelism is a wall-time optimization for later).

import { requestStructured, type AskAnswer } from "../core/structured.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { ChatMessage, Provider } from "../providers/types.js";

export interface RunCoordinateOptions {
  providers:  Readonly<Record<string, Provider>>;
  allowlist?: readonly string[] | null;
  bridge?:    BridgeHandle;
  moderator?: string;     // default "anthropic" (CFG.moderator analog)
  maxTokens?: number;     // per-call cap (default 4096)
}

const DEFERRED_OPTS = [
  "untrusted_input", "inject_session_memory",
] as const;

// ---------- Schemas (inlined from schema/tools.schema.json $defs) ----------

const ROLE_TURN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Role envelope produced by a single proposer/critic turn in coordinate.",
  properties: {
    role: { type: "string", enum: ["proposer", "critic"] },
    summary: {
      type: "string",
      description: "1-3 sentences capturing the position.",
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim:      { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["claim", "confidence"],
      },
    },
    confidence: {
      type: "number", minimum: 0, maximum: 1,
      description: "Overall confidence in the position.",
    },
    citations: { type: "array", items: { type: "string" } },
    ballot: {
      type: "string", enum: ["agree", "disagree", "abstain"],
      description: "Critic's stance on the proposal. Proposer always emits 'agree'.",
    },
  },
  required: ["role", "summary", "confidence"],
};

const STRUCTURED_SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Schema-validated synthesis output produced by the moderator/synthesizer role.",
  properties: {
    consensus: {
      type: "string",
      description: "What the panel converged on.",
    },
    weighted_confidence: { type: "number", minimum: 0, maximum: 1 },
    key_claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim:      { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          supporters: { type: "array", items: { type: "string" } },
          dissenters: { type: "array", items: { type: "string" } },
        },
        required: ["claim", "confidence"],
      },
    },
    dissent: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim:     { type: "string" },
          providers: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: ["claim", "providers"],
      },
    },
    citations:     { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["consensus", "weighted_confidence", "key_claims"],
};

// ---------- Public entry ---------------------------------------------------

export async function runCoordinate(
  args: Record<string, unknown>,
  opts: RunCoordinateOptions,
): Promise<Record<string, unknown>> {
  // v1 deferral.
  const needsBridge = DEFERRED_OPTS.some((k) => Boolean(args[k]))
    || (Array.isArray(args["worker_tools"])
        && (args["worker_tools"] as unknown[]).length > 0);
  if (needsBridge) {
    if (opts.bridge && opts.bridge.toolNames.has("coordinate")) {
      return await deferCoordinate(args, opts.bridge);
    }
    return errorEnvelope(
      "COORDINATE_OPT_NOT_NATIVE",
      "this coordinate opt-in requires the Python bridge in v1",
      "v1 native covers the plain three-role orchestration. Opts " +
        "(untrusted_input, inject_session_memory, worker_tools) defer.",
    );
  }

  const topic   = typeof args["topic"]   === "string" ? args["topic"]   : String(args["topic"]   ?? "");
  const context = typeof args["context"] === "string" ? args["context"] : "";

  // Provider resolution. Coordinate needs ≥ 2.
  const { selected, unknown: unknownNames, blocked } = resolveProviders(
    args["providers"], opts.providers, opts.allowlist ?? null,
  );
  if (selected.length < 2) {
    if (unknownNames.length > 0 && selected.length < 2) {
      return unknownProviderError(unknownNames, opts.providers);
    }
    if (blocked.length > 0) {
      return {
        tool:  "coordinate",
        error: "coordinate has fewer than 2 providers after allowlist filtering",
        blocked, allowlist: opts.allowlist ?? null,
        available_now: Object.keys(opts.providers).sort(),
      };
    }
    return {
      tool:  "coordinate",
      error: "coordinate needs at least 2 providers with keys in .env",
      available_now: Object.keys(opts.providers).sort(),
    };
  }

  // Role resolution. Mirrors Python's tiered fallback exactly.
  const proposerName = (typeof args["proposer"] === "string" && args["proposer"])
    ? args["proposer"]
    : selected[0]!.name;
  // Python: synth_name = args.synthesizer || args.moderator || CFG.moderator
  // || selected[-1]. CFG.moderator defaults to "anthropic" — we match that
  // default here so the role resolution lines up byte-equal.
  const synthName = (typeof args["synthesizer"] === "string" && args["synthesizer"])
    ? args["synthesizer"]
    : (typeof args["moderator"] === "string" && args["moderator"])
      ? args["moderator"]
      : (opts.moderator ?? "anthropic");
  // If even that fallback isn't reachable, we'll degrade to selected[-1]
  // when looking up the provider (see synth resolution below).

  // Resolve role providers — explicit name uses opts.providers map.
  const proposer = opts.providers[proposerName.toLowerCase()] ?? selected[0]!;
  // Python: `synth = ALL_PROVIDERS.get(synth_name) or proposer`.
  // Falls back to proposer (not selected[-1]) when the named synth
  // isn't reachable. Match exactly.
  const synth    = opts.providers[synthName.toLowerCase()] ?? proposer;

  // Resolve critics: explicit list if provided + filtered to known
  // providers, else "selected minus proposer minus synth" with a
  // fallback "anyone except proposer (truncated to 1)" if empty.
  let critics: Provider[] = [];
  if (Array.isArray(args["critics"])) {
    for (const n of args["critics"] as unknown[]) {
      if (typeof n !== "string") continue;
      const p = opts.providers[n.toLowerCase()];
      if (p !== undefined) critics.push(p);
    }
  } else {
    critics = selected.filter(
      (p) => p.name !== proposer.name && p.name !== synth.name,
    );
    if (critics.length === 0) {
      critics = selected.filter((p) => p.name !== proposer.name).slice(0, 1);
    }
  }
  if (critics.length === 0) {
    return {
      tool:  "coordinate",
      error: "coordinate could not assign at least one critic distinct from the proposer",
      available_now: Object.keys(opts.providers).sort(),
    };
  }

  const maxTokens = opts.maxTokens ?? 4096;

  // Topic block: TOPIC + optional CONTEXT.
  let topicBlock = `TOPIC: ${topic}`;
  if (context) topicBlock += `\n\nCONTEXT:\n${context}`;

  // Base system message — byte-equal with Python.
  const sysMsg =
    "You are part of a structured coordination flow with three roles: " +
    "proposer, critic, synthesizer. Stay strictly in the role you are given. " +
    "Be specific, cite assumptions, and prefer concrete claims to generic prose.";

  // ---- Step 1: Proposer -------------------------------------------------
  const propSystem = sysMsg +
    "\n\nYou are the PROPOSER. Draft an initial position with claims and " +
    "confidence values. Set role=\"proposer\" and ballot=\"agree\" in your envelope.";
  const propMessages: ChatMessage[] = [
    { role: "system", content: propSystem },
    { role: "user",   content: topicBlock },
  ];
  const propResult = await requestStructured(
    proposer, propMessages, ROLE_TURN_SCHEMA,
    { maxTokens, maxRetries: 1, purpose: "worker" },
  );
  const proposalObj = propResult.obj as Record<string, unknown> | null;
  const proposalAns = propResult.answer;
  const proposalRender = formatRoleTurn(
    "proposer", proposalObj, proposalAns.response ?? "",
  );

  // ---- Step 2: Critics --------------------------------------------------
  const critSystem = sysMsg +
    "\n\nYou are a CRITIC. Identify weak claims, missed cases, and risks in the " +
    "proposal. Set role=\"critic\" and choose ballot in {agree, disagree, abstain}.";

  const critiqueAnswers:    AskAnswer[] = [];
  const critiqueStructured: (Record<string, unknown> | null)[] = [];
  for (const cp of critics) {
    const msgs: ChatMessage[] = [
      { role: "system", content: critSystem },
      {
        role: "user",
        content: `${topicBlock}\n\nPROPOSAL:\n${proposalRender}`,
      },
    ];
    const r = await requestStructured(
      cp, msgs, ROLE_TURN_SCHEMA,
      { maxTokens, maxRetries: 1, purpose: "worker" },
    );
    critiqueAnswers.push(r.answer);
    critiqueStructured.push(r.obj as Record<string, unknown> | null);
  }

  // ---- Step 3: Synthesizer ---------------------------------------------
  const synthSystem = sysMsg +
    "\n\nYou are the SYNTHESIZER. Read the proposal and the critiques. Produce a " +
    "single grounded synthesis as JSON matching the schema (consensus, weighted_confidence, " +
    "key_claims, dissent, citations, open_questions). Reflect real disagreement when it " +
    "exists; do not paper over it.";
  const critiqueBlock = critiqueStructured.length > 0
    ? critiqueStructured
        .map((obj, i) =>
          formatRoleTurn(
            `critic[${critics[i]!.name}]`,
            obj,
            critiqueAnswers[i]?.response ?? "",
          ),
        )
        .join("\n\n")
    : "(no critiques)";
  const synthMessages: ChatMessage[] = [
    { role: "system", content: synthSystem },
    {
      role: "user",
      content: `${topicBlock}\n\nPROPOSAL:\n${proposalRender}\n\nCRITIQUES:\n${critiqueBlock}`,
    },
  ];
  const synthResult = await requestStructured(
    synth, synthMessages, STRUCTURED_SYNTHESIS_SCHEMA,
    { maxTokens, maxRetries: 1, purpose: "synth" },
  );
  const synthObj = synthResult.obj as Record<string, unknown> | null;
  const synthAns = synthResult.answer;
  const synthErrs = synthResult.errors;

  const result: Record<string, unknown> = {
    tool: "coordinate",
    topic,
    roles: {
      proposer:    proposer.name,
      critics:     critics.map((p) => p.name),
      synthesizer: synth.name,
    },
    proposal_answer:      proposalAns,
    proposal_structured:  proposalObj,
    critique_answers:     critiqueAnswers,
    critique_structured:  critiqueStructured,
    synthesis_answer:     synthAns,
    synthesis_structured: synthObj,
  };
  if (synthErrs.length > 0) result["synthesis_errors"] = synthErrs;
  if (unknownNames.length > 0) result["skipped_unknown_providers"] = unknownNames;
  if (blocked.length > 0)      result["blocked_by_allowlist"]      = blocked;
  return result;
}

/** Direct port of `_format_role_turn`. Used to render the proposer
 *  output into the critic prompt + each critic's output into the
 *  synthesizer prompt. The prefix bytes matter — Python's f-string
 *  layout is part of the round-trip parity contract. */
function formatRoleTurn(
  role: string,
  obj: Record<string, unknown> | null,
  fallbackText: string,
): string {
  if (!obj) {
    return fallbackText || `(${role}: no structured output)`;
  }
  const parts: string[] = [
    `[${role}] summary: ${obj["summary"] ?? ""}`,
    `  confidence: ${obj["confidence"] ?? "?"}`,
  ];
  if (typeof obj["ballot"] === "string" && obj["ballot"]) {
    parts.push(`  ballot: ${obj["ballot"]}`);
  }
  const claims = Array.isArray(obj["claims"]) ? obj["claims"] : [];
  for (const c of claims) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, unknown>;
    parts.push(`  - claim: ${co["claim"]} (conf=${co["confidence"]})`);
  }
  const citations = Array.isArray(obj["citations"]) ? obj["citations"] : [];
  for (const cit of citations) {
    parts.push(`  cite: ${cit}`);
  }
  return parts.join("\n");
}

// ---------- Helpers (provider resolution, deferral, errors) ----------

interface ResolveResult {
  selected: Provider[];
  unknown:  string[];
  blocked:  string[];
}

function resolveProviders(
  names: unknown,
  available: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
): ResolveResult {
  const out: ResolveResult = { selected: [], unknown: [], blocked: [] };
  if (!Array.isArray(names) || names.length === 0) {
    for (const [, p] of Object.entries(available)) {
      if (allowlist !== null && !allowlist.includes(p.name)) {
        out.blocked.push(p.name);
        continue;
      }
      out.selected.push(p);
    }
    return out;
  }
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    const key = n.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const p = available[key];
    if (p === undefined) { out.unknown.push(String(n)); continue; }
    if (allowlist !== null && !allowlist.includes(p.name)) {
      out.blocked.push(p.name); continue;
    }
    out.selected.push(p);
  }
  return out;
}

const KNOWN_PROVIDERS = [
  "anthropic", "openai", "xai", "gemini", "mistral", "groq", "deepseek",
] as const;

function unknownProviderError(
  unknownNames: string[],
  available: Readonly<Record<string, Provider>>,
): Record<string, unknown> {
  const notRegistered: string[] = [];
  const typos:         string[] = [];
  for (const n of unknownNames) {
    const key = n.trim().toLowerCase();
    if ((KNOWN_PROVIDERS as readonly string[]).includes(key)) notRegistered.push(n);
    else typos.push(n);
  }
  return {
    error:                "requested providers are not available",
    unknown:               unknownNames,
    needs_api_key_in_env:  notRegistered,
    unrecognised_names:    typos,
    available_now:         Object.keys(available).sort(),
  };
}

async function deferCoordinate(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("coordinate", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "COORDINATE_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for coordinate",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(code: string, message: string, hint: string): Record<string, unknown> {
  return {
    tool:          "coordinate",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

export const __test_internals = {
  ROLE_TURN_SCHEMA,
  STRUCTURED_SYNTHESIS_SCHEMA,
  DEFERRED_OPTS,
  formatRoleTurn,
  resolveProviders,
};
