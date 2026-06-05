// Native TS port of Python's `tool_confer` — Phase 5 part 5.
//
// SCOPE for v1 (plain single-shot panel):
//   - N providers, same question, parallel-or-sequential dispatch.
//   - Output envelope: {tool, question, answers}, where each answer
//     is the askOne shape (provider, model, response, attempts, usage,
//     elapsed_ms, cpu_ms, cache_hit, timing).
//
// OUT OF SCOPE for v1 — any of these opts → defer to bridge:
//   - untrusted_input (canary mint + _wrap_untrusted)
//   - extract_claims  (claim distillation via cheap-tier judge)
//   - early_stop      (multi-phase agreement check)
//   - inject_session_memory  (DB read)
//   - worker_tools    (verify/fetch hops inside the LLM turn)
//   - auto_panel      (router-recommended panel pick)
//
// All sweep in when the underlying subsystems port.

import { askOne } from "../core/structured.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { ChatMessage, Provider } from "../providers/types.js";

export interface RunConferOptions {
  providers: Readonly<Record<string, Provider>>;
  allowlist?: readonly string[] | null;
  bridge?:    BridgeHandle;
  /** Per-call max_tokens. v1 defaults to 4096 — typical confer scope. */
  maxTokens?: number;
}

/** Args that, when truthy, require the Python bridge in v1. */
const DEFERRED_OPTS = [
  "untrusted_input", "extract_claims", "early_stop",
  "inject_session_memory", "auto_panel",
] as const;

export async function runConfer(
  args: Record<string, unknown>,
  opts: RunConferOptions,
): Promise<Record<string, unknown>> {
  // Defer to bridge when any v1-out-of-scope opt is on, or when
  // worker_tools is a non-empty list.
  const needsBridge = DEFERRED_OPTS.some((k) => Boolean(args[k]))
    || (Array.isArray(args["worker_tools"])
        && (args["worker_tools"] as unknown[]).length > 0);
  if (needsBridge) {
    if (opts.bridge && opts.bridge.toolNames.has("confer")) {
      return await deferConfer(args, opts.bridge);
    }
    return errorEnvelope(
      "CONFER_OPT_NOT_NATIVE",
      "this confer opt-in requires the Python bridge in v1",
      "Disable the opt or set CROSSCHECK_BRIDGE_PYTHON=1. " +
        "v1 native covers the plain panel-call path; opts " +
        "(untrusted_input, extract_claims, early_stop, " +
        "inject_session_memory, auto_panel, worker_tools) defer.",
    );
  }

  const question = typeof args["question"] === "string"
    ? args["question"]
    : String(args["question"] ?? "");
  const context = typeof args["context"] === "string"
    ? args["context"] : "";

  // Provider resolution.
  const { selected, unknown: unknownNames, blocked } = resolveProviders(
    args["providers"], opts.providers, opts.allowlist ?? null,
  );
  if (selected.length === 0) {
    if (unknownNames.length > 0) return unknownProviderError(unknownNames, opts.providers);
    if (blocked.length > 0) {
      return {
        tool:  "confer",
        error: "all requested providers are blocked by provider_allowlist",
        blocked,
        allowlist: opts.allowlist ?? null,
      };
    }
    return { tool: "confer", error: "no active providers have API keys in .env" };
  }

  // Messages: system + optional context user + user question. Byte-equal
  // with Python (system_lines join, no untrusted wrap in v1).
  const sysMsg =
    "You are part of a panel of LLMs consulted by an engineer working inside " +
    "Claude Code. Answer directly, cite assumptions, and keep it crisp.";
  const messages: ChatMessage[] = [{ role: "system", content: sysMsg }];
  if (context) {
    messages.push({ role: "user", content: `CONTEXT:\n${context}` });
  }
  messages.push({ role: "user", content: question });

  // Dispatch — sequential in v1.
  const maxTokens = opts.maxTokens ?? 4096;
  const answers = [];
  for (const p of selected) {
    answers.push(await askOne(p, messages, {
      maxTokens, temperature: 0.4, purpose: "confer",
    }));
  }

  const result: Record<string, unknown> = {
    tool:     "confer",
    question,
    answers,
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

async function deferConfer(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("confer", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "CONFER_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for confer",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(code: string, message: string, hint: string): Record<string, unknown> {
  return {
    tool:          "confer",
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

// Internal helpers for tests.
export const __test_internals = {
  resolveProviders,
  DEFERRED_OPTS,
};
