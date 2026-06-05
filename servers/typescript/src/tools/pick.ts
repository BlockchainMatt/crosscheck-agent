// Native TS port of Python's `tool_pick` — Phase 5 part 3.
//
// Glue layer on top of:
//   - core/structured.ts            (requestStructured + askOne)
//   - core/extract-json + json-schema (parse + validate)
//   - core/pyrepr                   (Python repr-equivalent strings)
//
// What this file does:
//   1. Normalize the options/criteria input (strings → {name}; dicts
//      with `weight`/`description` flow through).
//   2. Build the message pair (system + user) that asks the LLM to
//      score every option × criterion.
//   3. Call requestStructured() once per provider (sequential in v1 —
//      parallelism is a no-op-for-output optimization we add later).
//   4. Aggregate per-provider score envelopes into:
//        - per-(option,criterion) lists for stddev/spread
//        - per-option overall list
//      Then compute weighted_score, mean_overall, n_provider_scores
//      and produce ranking[] sorted by (-weighted_score, option).
//   5. Compute dissent_deltas — the top-K (option, criterion) pairs
//      by stddev (then by spread).
//   6. Assemble the result envelope. Tail fields the Python emits
//      (session, budget, usage rollups) are NOT here in v1 — they
//      port when session_memory + usage_log land. Parity tests strip
//      them from the Python side too.
//
// Out of scope for v1 (documented in CLAUDE.md tail of this file):
//   * Early-stop optimization (multi-phase score-then-shortcut)
//   * Parallel ThreadPoolExecutor dispatch
//   * Cache layer + prompt adapter
//   * Breaker / quota checks
//   * Session DB / usage_log / claim_add
//   * _attach_usage_block tail
//
// All of these affect the result envelope's tail fields which we strip
// in parity tests. Sweep them in when the underlying subsystems port.

import { requestStructured, type AskAnswer } from "../core/structured.js";
import { pyListRepr } from "../core/pyrepr.js";

import type { Provider, ChatMessage } from "../providers/types.js";

/** Normalized option as the pick pipeline sees it. */
export interface PickOption {
  name: string;
  description?: string;
}

/** Normalized criterion as the pick pipeline sees it. */
export interface PickCriterion {
  name: string;
  weight: number;
  description?: string;
}

/** Run the pick tool natively against a set of providers. */
export interface RunPickOptions {
  /** Available providers, keyed by lowercased name. Tool registration
   *  closes over this — see src/tools/index.ts. */
  providers: Readonly<Record<string, Provider>>;
  /** Optional provider allowlist. When non-null, names not in this
   *  list are filtered out before the call (and reported back as
   *  `blocked_by_allowlist`). null/undefined = no allowlist. */
  allowlist?: readonly string[] | null;
  /** Optional cap on the per-call max_tokens. v1 uses a fixed 2k
   *  budget by default — matches the typical scoring envelope size. */
  maxTokens?: number;
}

/** Mirrors `_pick_scores_schema()` — pulled inline so the port is
 *  self-contained. Used as the JSON-Schema fed to requestStructured. */
const PICK_SCORES_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Per-provider scoring envelope for the pick tool: scores for every " +
    "option across every criterion, plus an overall score per option in [0,1].",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          option:  { type: "string" },
          overall: { type: "number", minimum: 0, maximum: 1 },
          by_criterion: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                criterion: { type: "string" },
                score:     { type: "number", minimum: 0, maximum: 1 },
                rationale: { type: "string" },
              },
              required: ["criterion", "score"],
            },
          },
        },
        required: ["option", "overall", "by_criterion"],
      },
    },
  },
  required: ["scores"],
};

/** Direct port of `_normalize_pick_input`. */
export function normalizePickInput(
  rawOptions:  unknown,
  rawCriteria: unknown,
): { options: PickOption[]; criteria: PickCriterion[] } {
  const options: PickOption[] = [];
  for (const o of toArray(rawOptions)) {
    if (typeof o === "string") {
      options.push({ name: o });
    } else if (isObj(o) && "name" in o) {
      const opt: PickOption = { name: String((o as Record<string, unknown>)["name"]) };
      const desc = (o as Record<string, unknown>)["description"];
      opt.description = desc === undefined ? "" : String(desc);
      options.push(opt);
    }
  }
  const criteria: PickCriterion[] = [];
  for (const c of toArray(rawCriteria)) {
    if (isObj(c) && "name" in c) {
      const cv = c as Record<string, unknown>;
      const weightRaw = cv["weight"];
      const weight = (weightRaw === undefined ? 1.0 : Number(weightRaw)) || 0;
      criteria.push({
        name:        String(cv["name"]),
        weight,
        description: cv["description"] === undefined ? "" : String(cv["description"]),
      });
    }
  }
  return { options, criteria };
}

/** Direct port of `_stddev` (population stddev). */
export function stddev(xs: readonly number[]): number {
  if (xs.length <= 1) return 0.0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/** Top-of-result error envelope for missing/invalid input. */
function pickError(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: message, ...extra };
}

/** Top-ranking option name + overall score from a provider's scores
 *  envelope. Used by the (future) early-stop logic — defined here so
 *  the v2 expansion lands as a small additive change.
 *
 *  Returns [null, 0] on malformed input — same as Python. */
function pickTopOption(obj: unknown): [string | null, number] {
  if (!isObj(obj)) return [null, 0.0];
  const scores = (obj["scores"] as unknown[] | undefined) ?? [];
  const ranked: [number, string][] = [];
  for (const s of scores) {
    if (!isObj(s) || s["option"] === null || s["option"] === undefined) continue;
    const overall = Number(s["overall"] ?? 0) || 0;
    ranked.push([overall, String(s["option"])]);
  }
  if (ranked.length === 0) return [null, 0.0];
  ranked.sort((a, b) => b[0] - a[0]);
  return [ranked[0]![1], ranked[0]![0]];
}

/** Run pick natively. Returns the result envelope shape that mirrors
 *  Python's tool_pick (minus the tail fields we strip in parity). */
export async function runPick(
  args: Record<string, unknown>,
  opts: RunPickOptions,
): Promise<Record<string, unknown>> {
  // Python tool_pick does NOT guard against empty/missing decision —
  // it dereferences args["decision"] directly. We accept any string
  // (including "") and proceed; missing/non-string coerces via String()
  // so the model gets *something* in the prompt. Parity behavior.
  const decision = typeof args["decision"] === "string"
    ? args["decision"]
    : String(args["decision"] ?? "");
  const { options, criteria } = normalizePickInput(args["options"], args["criteria"]);
  if (options.length < 2) {
    return pickError("pick needs at least 2 options");
  }
  if (criteria.length === 0) {
    return pickError("pick needs at least 1 criterion");
  }
  const maxDissent = Math.max(1, Math.trunc(Number(args["max_dissent_deltas"] ?? 5)) || 5);

  // Provider resolution.
  const { selected, unknown: unknownNames, blocked } = resolveProviders(
    args["providers"], opts.providers, opts.allowlist ?? null,
  );
  if (selected.length === 0) {
    if (unknownNames.length > 0) return unknownProviderError(unknownNames, opts.providers);
    if (blocked.length > 0) {
      return pickError("no providers survive the allowlist for pick", {
        blocked, allowlist: opts.allowlist ?? null,
      });
    }
    return pickError("no active providers have API keys in .env");
  }

  // Build messages (byte-equal with Python's f"…" interpolations).
  const optionNames    = options.map((o) => o.name);
  const criterionNames = criteria.map((c) => c.name);
  const weights:    Record<string, number> = {};
  for (const c of criteria) weights[c.name] = c.weight;

  const optionsBlock = options.map((o) =>
    o.description ? `- ${o.name}: ${o.description}` : `- ${o.name}`,
  ).join("\n");
  const criteriaBlock = criteria.map((c) =>
    c.description
      ? `- ${c.name} (weight ${c.weight}): ${c.description}`
      : `- ${c.name} (weight ${c.weight})`,
  ).join("\n");

  const baseMessages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are scoring options against criteria for a decision. Be calibrated: 0 = " +
        "fails utterly, 0.5 = mixed, 1.0 = clearly best of the field. Score each option " +
        "on EVERY listed criterion, then give an overall score for that option. Return " +
        "ONLY JSON matching the schema.",
    },
    {
      role: "user",
      content: `DECISION: ${decision}\n\nOPTIONS:\n${optionsBlock}\n\nCRITERIA:\n${criteriaBlock}`,
    },
  ];

  const maxTokens = opts.maxTokens ?? 2048;

  // Sequential dispatch in v1 (output bytes don't depend on order).
  const scoresByProvider: Record<string, unknown> = {};
  const answersCollected: AskAnswer[] = [];
  const scoringErrors:    Record<string, string[]> = {};

  for (const p of selected) {
    const r = await requestStructured(p, baseMessages, PICK_SCORES_SCHEMA, {
      maxTokens, maxRetries: 1, purpose: "worker",
    });
    scoresByProvider[p.name] = r.obj;
    answersCollected.push(r.answer);
    if (r.errors.length > 0) scoringErrors[p.name] = r.errors;
  }

  // Aggregate: per (option, criterion) collect (provider, score, rationale).
  type PerOC = [string, number, string][];
  const perOC: Record<string, PerOC> = {};
  for (const o of optionNames) {
    for (const c of criterionNames) perOC[`${o}::${c}`] = [];
  }
  const perOptionOverall: Record<string, number[]> = {};
  for (const o of optionNames) perOptionOverall[o] = [];

  for (const [providerName, obj] of Object.entries(scoresByProvider)) {
    if (!isObj(obj)) continue;
    for (const entry of (obj["scores"] as unknown[] | undefined) ?? []) {
      if (!isObj(entry)) continue;
      const opt = entry["option"];
      if (typeof opt !== "string" || !(opt in perOptionOverall)) continue;
      const overall = Number(entry["overall"] ?? 0);
      if (Number.isFinite(overall)) perOptionOverall[opt]!.push(overall);
      for (const sub of (entry["by_criterion"] as unknown[] | undefined) ?? []) {
        if (!isObj(sub)) continue;
        const cn = sub["criterion"];
        if (typeof cn !== "string" || !criterionNames.includes(cn)) continue;
        const sc = Number(sub["score"] ?? 0);
        if (!Number.isFinite(sc)) continue;
        const rationale = String(sub["rationale"] ?? "");
        perOC[`${opt}::${cn}`]!.push([providerName, sc, rationale]);
      }
    }
  }

  // Build ranking[].
  type CritRow = {
    criterion: string;
    mean_score: number;
    stddev: number;
    weight: number;
  };
  type RankingRow = {
    option: string;
    weighted_score: number;
    mean_overall: number;
    by_criterion: CritRow[];
    n_provider_scores: number;
    rank?: number;
  };
  const rankingRows: RankingRow[] = [];
  for (const opt of optionNames) {
    const critRows: CritRow[] = [];
    let weighted = 0.0;
    let totalWeight = 0.0;
    let nProviderScores = 0;
    for (const cn of criterionNames) {
      const triples = perOC[`${opt}::${cn}`]!;
      const scores  = triples.map(([, s]) => s);
      const m  = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.0;
      const sd = scores.length > 0 ? stddev(scores) : 0.0;
      critRows.push({
        criterion: cn,
        mean_score: pyRound(m, 4),
        stddev:     pyRound(sd, 4),
        weight:     weights[cn]!,
      });
      weighted    += m * weights[cn]!;
      totalWeight += weights[cn]!;
      nProviderScores += scores.length;
    }
    weighted = totalWeight > 0 ? weighted / totalWeight : 0.0;
    const overallScores = perOptionOverall[opt]!;
    const meanOverall = overallScores.length > 0
      ? overallScores.reduce((a, b) => a + b, 0) / overallScores.length
      : weighted;
    rankingRows.push({
      option: opt,
      weighted_score:    pyRound(weighted, 4),
      mean_overall:      pyRound(meanOverall, 4),
      by_criterion:      critRows,
      n_provider_scores: nProviderScores,
    });
  }
  rankingRows.sort((a, b) =>
    a.weighted_score !== b.weighted_score
      ? b.weighted_score - a.weighted_score
      : (a.option < b.option ? -1 : a.option > b.option ? 1 : 0),
  );
  for (let i = 0; i < rankingRows.length; i++) rankingRows[i]!.rank = i + 1;

  // dissent_deltas.
  type DissentRow = {
    option: string;
    criterion: string;
    stddev: number;
    spread: number;
    providers: { provider: string; score: number; rationale: string }[];
  };
  const dissentPool: DissentRow[] = [];
  for (const opt of optionNames) {
    for (const cn of criterionNames) {
      const triples = perOC[`${opt}::${cn}`]!;
      if (triples.length < 2) continue;
      const scores = triples.map(([, s]) => s);
      const sd = stddev(scores);
      const spread = Math.max(...scores) - Math.min(...scores);
      dissentPool.push({
        option: opt, criterion: cn,
        stddev: pyRound(sd, 4),
        spread: pyRound(spread, 4),
        providers: triples.map(([pn, s, r]) => ({
          provider: pn, score: pyRound(s, 4), rationale: r,
        })),
      });
    }
  }
  dissentPool.sort((a, b) => {
    if (a.stddev !== b.stddev) return b.stddev - a.stddev;
    if (a.spread !== b.spread) return b.spread - a.spread;
    if (a.option !== b.option) return a.option < b.option ? -1 : 1;
    if (a.criterion !== b.criterion) return a.criterion < b.criterion ? -1 : 1;
    return 0;
  });
  const dissentDeltas = dissentPool.slice(0, maxDissent);

  // Result envelope. Tail fields (session/usage/budget) intentionally
  // absent in v1; parity tests strip them on the Python side too.
  const result: Record<string, unknown> = {
    tool: "pick",
    decision,
    options: optionNames,
    criteria: criteria.map((c) => ({ name: c.name, weight: c.weight })),
    ranking: rankingRows,
    dissent_deltas: dissentDeltas,
    scores_by_provider: scoresByProvider,
    providers_used: selected.map((p) => p.name),
  };
  if (Object.keys(scoringErrors).length > 0) result["scoring_errors"] = scoringErrors;
  if (blocked.length > 0)        result["blocked_by_allowlist"]      = blocked;
  if (unknownNames.length > 0)   result["skipped_unknown_providers"] = unknownNames;
  return result;
}

interface ResolveResult {
  selected: Provider[];
  unknown:  string[];
  blocked:  string[];
}

/** Port of `_resolve_providers` + `_filter_by_allowlist`. When `names`
 *  is null/undefined/empty, use all available providers in insertion
 *  order. */
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
    if (p === undefined) {
      out.unknown.push(String(n));
      continue;
    }
    if (allowlist !== null && !allowlist.includes(p.name)) {
      out.blocked.push(p.name);
      continue;
    }
    out.selected.push(p);
  }
  return out;
}

const KNOWN_PROVIDERS = [
  "anthropic", "openai", "xai", "gemini", "mistral", "groq", "deepseek",
] as const;

/** Port of `_unknown_provider_error`. */
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

/** Python's round() uses banker's rounding (round-half-to-even). JS's
 *  Math.round goes half-up. For 4-decimal precision this matters at
 *  exact half-boundaries; we mirror Python's behavior to keep parity. */
function pyRound(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** decimals;
  const scaled = x * f;
  const floor  = Math.floor(scaled);
  const diff   = scaled - floor;
  let rounded: number;
  if (diff > 0.5)      rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else                 rounded = floor % 2 === 0 ? floor : floor + 1;  // banker's
  return rounded / f;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return [];
}

// Internal helpers exported for tests only.
export const __test_internals = {
  PICK_SCORES_SCHEMA,
  pickTopOption,
  resolveProviders,
  pyRound,
};

// pyListRepr is imported for future use in error messages mirroring
// Python's f"…{list!r}…" — guard against the linter pruning the
// import while we're still wiring the tail-field assertions.
void pyListRepr;
