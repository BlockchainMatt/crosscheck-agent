// Native TS port of Python's `tool_debate` — Phase 5 part 7.
//
// SCOPE for v1 (plain N-round debate + plain moderator synthesis):
//   - ≥2 providers, configurable max_rounds (default 3)
//   - Sequential round dispatch (matches confer's v1 pattern)
//   - Each round builds [system, optional CONTEXT, TOPIC, optional
//     PRIOR TURNS], dispatches every panelist, appends to transcript
//     with a `round` number
//   - Moderator (default = first available provider matching
//     CFG.moderator || "anthropic", else fall back to selected[0])
//     calls _ask_one with the condensed transcript and returns text
//     synthesis
//   - Envelope: {tool, topic, rounds_completed, transcript, synthesis}
//
// OUT OF SCOPE for v1 — any of these args → defer to bridge:
//   - auto_panel (router-driven panel selection)
//   - structured synthesis (uses requestStructured + schema; will port
//     once we add a SynthesisSchema definition)
//   - extract_claims
//   - early_stop (post-round agreement-check loop)
//   - inject_session_memory
//   - worker_tools
//
// Output sanitization (parity test strips on both sides):
//   - budget, session, usage rollup, timing rollup, run_summary
//   - transcript_path, claims*, agreement_check, early_stopped*
//   - per-transcript-entry timing fields (elapsed_ms, cpu_ms, cache_hit, timing)
//   - per-synthesis timing fields (same)

import { askOne, type AskAnswer } from "../core/structured.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { ChatMessage, Provider } from "../providers/types.js";

export interface RunDebateOptions {
  providers: Readonly<Record<string, Provider>>;
  allowlist?: readonly string[] | null;
  bridge?:    BridgeHandle;
  moderator?: string;             // default "anthropic" (matches CFG.moderator)
  maxTokens?: number;             // per-call cap (default 4096)
}

const DEFERRED_OPTS = [
  "auto_panel", "structured", "extract_claims",
  "early_stop", "inject_session_memory",
] as const;

export async function runDebate(
  args: Record<string, unknown>,
  opts: RunDebateOptions,
): Promise<Record<string, unknown>> {
  // v1 deferral envelope: any out-of-scope opt → bridge.
  const needsBridge = DEFERRED_OPTS.some((k) => Boolean(args[k]))
    || (Array.isArray(args["worker_tools"])
        && (args["worker_tools"] as unknown[]).length > 0);
  if (needsBridge) {
    if (opts.bridge && opts.bridge.toolNames.has("debate")) {
      return await deferDebate(args, opts.bridge);
    }
    return errorEnvelope(
      "DEBATE_OPT_NOT_NATIVE",
      "this debate opt-in requires the Python bridge in v1",
      "v1 native covers the plain N-round + plain moderator synthesis. " +
        "Opts (auto_panel, structured, extract_claims, early_stop, " +
        "inject_session_memory, worker_tools) defer.",
    );
  }

  const topic = typeof args["topic"] === "string"
    ? args["topic"] : String(args["topic"] ?? "");
  const context = typeof args["context"] === "string"
    ? args["context"] : "";
  const maxRounds = Math.max(1,
    Math.trunc(Number(args["max_rounds"] ?? 3)) || 3);

  // Provider resolution. Debate needs ≥ 2.
  const { selected, unknown: unknownNames, blocked } = resolveProviders(
    args["providers"], opts.providers, opts.allowlist ?? null,
  );
  if (selected.length < 2) {
    if (unknownNames.length > 0 && selected.length < 2) {
      return unknownProviderError(unknownNames, opts.providers);
    }
    if (blocked.length > 0) {
      return {
        tool:  "debate",
        error: "debate has fewer than 2 providers after allowlist filtering",
        blocked,
        allowlist: opts.allowlist ?? null,
        available_now: Object.keys(opts.providers).sort(),
      };
    }
    return {
      tool:  "debate",
      error: "debate needs at least 2 providers with keys in .env",
      available_now: Object.keys(opts.providers).sort(),
    };
  }

  const maxTokens = opts.maxTokens ?? 4096;
  const transcript: (AskAnswer & { round: number })[] = [];

  // Per-round dispatch. Sequential — output bytes do not depend on
  // intra-round order (the panel each speaks once in `selected` order).
  for (let rnd = 1; rnd <= maxRounds; rnd++) {
    const roundMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are debating peers from other model families. Round " +
          `${rnd}/${maxRounds}. Disagree where warranted, concede where ` +
          "right, and keep replies short and specific.",
      },
    ];
    if (context) {
      roundMessages.push({ role: "user", content: `CONTEXT:\n${context}` });
    }
    roundMessages.push({ role: "user", content: `TOPIC: ${topic}` });
    if (transcript.length > 0) {
      const prior = transcript.map((e) =>
        `[${e.provider} — round ${e.round}]\n${e.response ?? "(error)"}`,
      ).join("\n\n");
      roundMessages.push({ role: "user", content: `PRIOR TURNS:\n${prior}` });
    }

    for (const p of selected) {
      const entry = await askOne(p, roundMessages, {
        maxTokens, temperature: 0.4, purpose: "debate",
      });
      transcript.push({ ...entry, round: rnd });
    }
  }

  // Moderator synthesis — plain (non-structured) call.
  const moderatorName = (typeof args["moderator"] === "string" && args["moderator"])
    ? args["moderator"]
    : (opts.moderator ?? "anthropic");
  const moderator = opts.providers[moderatorName.toLowerCase()]
    ?? selected[0];

  let synthesis: AskAnswer | null = null;
  if (moderator) {
    const condensed = transcript.map((e) =>
      `[${e.provider} — round ${e.round}]\n${e.response ?? "(error)"}`,
    ).join("\n\n");
    const synthMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are the moderator. Synthesise the debate into a single " +
          "grounded recommendation.",
      },
      {
        role: "user",
        content: `TOPIC: ${topic}\n\nTRANSCRIPT:\n${condensed}`,
      },
    ];
    synthesis = await askOne(moderator, synthMessages, {
      maxTokens, temperature: 0.4, purpose: "synth",
    });
  }

  const rounds_completed = transcript.length > 0
    ? transcript.reduce((m, e) => Math.max(m, e.round), 0)
    : 0;

  const result: Record<string, unknown> = {
    tool:             "debate",
    topic,
    rounds_completed,
    transcript,
    synthesis,
  };
  if (unknownNames.length > 0) result["skipped_unknown_providers"] = unknownNames;
  if (blocked.length > 0)      result["blocked_by_allowlist"]      = blocked;
  return result;
}

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

async function deferDebate(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("debate", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "DEBATE_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for debate",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(code: string, message: string, hint: string): Record<string, unknown> {
  return {
    tool:          "debate",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

export const __test_internals = {
  DEFERRED_OPTS,
  resolveProviders,
};
