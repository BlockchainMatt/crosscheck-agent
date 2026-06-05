// Native TS port of Python's `tool_critique` — Phase 5 part 11.
//
// SCOPE for v1:
//   - Each panelist scores N weaknesses (default 3, capped at 5) via
//     a single structured-output call using requestStructured +
//     CRITIQUE_RESPONSE_SCHEMA.
//   - Output envelope: {tool, question, providers, per_provider,
//     weaknesses, high_severity_count}.
//   - Weaknesses across providers are merged + sorted by
//     (severity_rank, provider). Severity aliases normalised
//     ("medium" → "med").
//   - On parse failure for any panelist, per_provider entry uses
//     status="parse_error" with weaknesses=[] (rather than crashing).
//
// OUT OF SCOPE for v1 — defer to bridge when set:
//   - untrusted_input (canary mint + wrap)
//   - All session/log_usage/breaker concerns (stripped in parity).

import { requestStructured } from "../core/structured.js";

import type { BridgeHandle } from "../bridge/index.js";
import type { ChatMessage, Provider } from "../providers/types.js";

const CRITIQUE_MAX_WEAKNESSES = 5;

const SEVERITY_ALIASES: Readonly<Record<string, string>> = {
  medium: "med", high: "high", med: "med", low: "low",
};

const SEV_ORDER: Readonly<Record<string, number>> = {
  high: 0, med: 1, low: 2,
};

/** Inlined from Python `_critique_response_schema`. */
const CRITIQUE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    weaknesses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:          { type: "string" },
          weakness:    { type: "string" },
          why_matters: { type: "string" },
          severity:    { type: "string", enum: ["low", "med", "high"] },
        },
        required: ["weakness", "severity"],
      },
    },
  },
  required: ["weaknesses"],
};

export interface RunCritiqueOptions {
  providers:  Readonly<Record<string, Provider>>;
  allowlist?: readonly string[] | null;
  bridge?:    BridgeHandle;
  maxTokens?: number;
}

const DEFERRED_OPTS = ["untrusted_input"] as const;

export async function runCritique(
  args: Record<string, unknown>,
  opts: RunCritiqueOptions,
): Promise<Record<string, unknown>> {
  // Defer untrusted_input to bridge in v1.
  if (DEFERRED_OPTS.some((k) => Boolean(args[k]))) {
    if (opts.bridge && opts.bridge.toolNames.has("critique")) {
      return await deferCritique(args, opts.bridge);
    }
    return errorEnvelope(
      "CRITIQUE_OPT_NOT_NATIVE",
      "untrusted_input requires the Python bridge in v1",
      "Set CROSSCHECK_BRIDGE_PYTHON=1 to enable canary minting + " +
        "wrap_untrusted for indirect-injection detection.",
    );
  }

  const proposal = args["proposal"];
  if (typeof proposal !== "string" || proposal.trim() === "") {
    return errorEnvelope(
      "CRITIQUE_MISSING_PROPOSAL",
      "must provide `proposal` (the text to critique)",
      "Pass the answer/plan/code you want the panel to find weaknesses in.",
    );
  }
  const question = typeof args["question"] === "string" ? args["question"] : "";
  const maxPer = Math.max(1, Math.min(
    CRITIQUE_MAX_WEAKNESSES,
    Math.trunc(Number(args["max_per_provider"] ?? 3)) || 3,
  ));

  // Provider resolution.
  const { selected, unknown: unknownNames, blocked } = resolveProviders(
    args["providers"], opts.providers, opts.allowlist ?? null,
  );
  if (selected.length === 0) {
    if (unknownNames.length > 0) return unknownProviderError(unknownNames, opts.providers);
    if (blocked.length > 0) {
      return {
        tool: "critique",
        ...errorEnvelope(
          "ALL_PROVIDERS_BLOCKED",
          "all requested providers are blocked by provider_allowlist",
          `Either remove names from provider_allowlist or pick from ` +
            `${Object.keys(opts.providers).sort().join(", ")}.`,
          "config",
        ),
      };
    }
    return {
      tool: "critique",
      ...errorEnvelope(
        "NO_PROVIDERS_AVAILABLE",
        "no active providers have API keys in .env",
        "Set at least one provider API key in .env.",
        "config",
      ),
    };
  }

  // Build messages — byte-equal with Python's f-string.
  const sysMsg =
    "You are a pre-mortem critic on a panel. Read the PROPOSAL and list " +
    `its top ${maxPer} most consequential weaknesses. Output ONLY a JSON ` +
    "object matching the schema. Each weakness has `weakness` (one " +
    "sentence), `why_matters` (one sentence on the impact if missed), and " +
    "`severity` in {low, med, high}. Be concrete and adversarial; don't " +
    "sugar-coat. If the proposal is solid, return fewer than the cap or " +
    "an empty list — quality over quota.";
  const userMsg =
    (question ? `ORIGINAL QUESTION/DECISION:\n${question}\n\n` : "") +
    `PROPOSAL TO CRITIQUE:\n${proposal}`;
  const msgs: ChatMessage[] = [
    { role: "system", content: sysMsg },
    { role: "user",   content: userMsg },
  ];

  const maxTokens = opts.maxTokens ?? 2048;

  // Sequential dispatch (parallel is wall-time optimization for later).
  type CritiqueRow = {
    provider: string;
    model:    string;
    status:   "ok" | "parse_error";
    weaknesses: {
      id:          string;
      weakness:    string;
      why_matters: string;
      severity:    string;
      provider:    string;
    }[];
  };
  const perProvider: CritiqueRow[] = [];
  const merged: CritiqueRow["weaknesses"] = [];

  for (const p of selected) {
    const r = await requestStructured(p, msgs, CRITIQUE_RESPONSE_SCHEMA, {
      maxTokens, maxRetries: 1, purpose: "synth",
    });
    const obj = r.obj as { weaknesses?: unknown } | null;
    if (!obj || !Array.isArray(obj.weaknesses)) {
      perProvider.push({
        provider: p.name, model: p.model,
        status: "parse_error",
        weaknesses: [],
      });
      continue;
    }
    const providerWeaknesses: CritiqueRow["weaknesses"] = [];
    for (let i = 0; i < Math.min(obj.weaknesses.length, maxPer); i++) {
      const w = obj.weaknesses[i];
      if (!isObj(w) || !w["weakness"]) continue;
      const sevRaw = String(w["severity"] ?? "med").toLowerCase();
      const severity = SEVERITY_ALIASES[sevRaw] ?? "med";
      const entry = {
        id:          (typeof w["id"] === "string" && w["id"])
                       ? w["id"] : `${p.name}.w${i + 1}`,
        weakness:    String(w["weakness"]),
        why_matters: String(w["why_matters"] ?? ""),
        severity,
        provider:    p.name,
      };
      providerWeaknesses.push(entry);
      merged.push(entry);
    }
    perProvider.push({
      provider: p.name, model: p.model,
      status: "ok",
      weaknesses: providerWeaknesses,
    });
  }

  // Merge sort: severity ASC by rank (high first), then provider ASC.
  merged.sort((a, b) => {
    const sa = SEV_ORDER[a.severity] ?? 1;
    const sb = SEV_ORDER[b.severity] ?? 1;
    if (sa !== sb) return sa - sb;
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  });

  const highCount = merged.filter((w) => w.severity === "high").length;

  const result: Record<string, unknown> = {
    tool:                 "critique",
    question,
    providers:            selected.map((p) => p.name),
    per_provider:         perProvider,
    weaknesses:           merged,
    high_severity_count:  highCount,
  };
  if (unknownNames.length > 0) result["skipped_unknown_providers"] = unknownNames;
  if (blocked.length > 0)      result["blocked_by_allowlist"]      = blocked;
  return result;
}

// ---------- helpers ----------

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

async function deferCritique(
  args: Record<string, unknown>,
  bridge: BridgeHandle,
): Promise<Record<string, unknown>> {
  const r = await bridge.callTool("critique", args);
  const text = r.content[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  return errorEnvelope(
    "CRITIQUE_BRIDGE_BAD_ENVELOPE",
    "bridge returned an unparseable envelope for critique",
    "Check that the Python child is healthy.",
  );
}

function errorEnvelope(
  code: string, message: string, hint: string, kind = "client",
): Record<string, unknown> {
  return {
    tool:          "critique",
    error:         message,
    error_code:    code,
    error_kind:    kind,
    operator_hint: hint,
    transient:     false,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const __test_internals = {
  CRITIQUE_RESPONSE_SCHEMA,
  SEVERITY_ALIASES,
  SEV_ORDER,
};
