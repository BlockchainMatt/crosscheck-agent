// Audit rubric defaults + coalesce-mode aggregation.
//
// Mirrors `DEFAULT_AUDIT_RUBRICS` + `_coerce_pass` + `_coalesce_audit_items`
// from `servers/python/crosscheck_server.py` byte-for-byte. The judge-
// selection wrapper (`_select_audit_judges` / `_select_auditor`) is a
// Phase-5 task — it reaches into ALL_PROVIDERS + the smart router; once
// the provider registry is ported we'll add the wrapper here too.
//
// The coalesce aggregator is the heaviest pure-function in the whole
// port (≈ 80 LOC of subtle math + tie-break rules). Every branch is
// covered by the parity fixture.

// ----------------------------------------------------------------------
// Default rubric. Ships identical to Python's DEFAULT_AUDIT_RUBRICS list.
// ----------------------------------------------------------------------

export type RubricSeverity = "low" | "med" | "high";

export interface RubricItem {
  id: string;
  description: string;
  severity: RubricSeverity;
}

export const DEFAULT_AUDIT_RUBRICS: readonly RubricItem[] = [
  { id: "factual_grounding",
    description: "Claims are grounded in evidence, sources, or stated assumptions; no hallucinated facts or APIs.",
    severity: "high" },
  { id: "constraint_adherence",
    description: "Output respects all stated user constraints (scope, language, format, budget).",
    severity: "high" },
  { id: "no_pii_leak",
    description: "Output does not echo or leak emails, secrets, API keys, IPs, or other personally identifying data.",
    severity: "high" },
  { id: "internally_consistent",
    description: "Output is internally consistent; later statements do not contradict earlier ones.",
    severity: "med" },
  { id: "covers_open_questions",
    description: "Identifies and surfaces open questions or unresolved trade-offs instead of papering over them.",
    severity: "med" },
  { id: "actionability",
    description: "Output is concrete and actionable for the stated audience; not vague hand-waving.",
    severity: "low" },
];

const SEVERITY_ALIASES: Readonly<Record<string, RubricSeverity>> = {
  medium: "med",
  high:   "high",
  med:    "med",
  low:    "low",
};

// Auto-flag thresholds (mirror Python module-level constants).
export const AUDIT_OBVIOUS_FAILURE_HIGH = 0.3;
export const AUDIT_OBVIOUS_FAILURE_MED  = 0.2;
export const AUDIT_DISAGREEMENT_STDDEV  = 0.3;
export const AUDIT_DISAGREEMENT_RANGE   = 0.4;

// ----------------------------------------------------------------------
// _coerce_pass — robust truthy-string parser.
// ----------------------------------------------------------------------

/** Coerce a JSON `pass` field to bool. Returns `null` when the value is
 *  unparseable (e.g. arbitrary string). Mirrors Python's
 *  `_coerce_pass`. Note: empty string ⇒ false (Python's mapping). */
export function coercePass(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Boolean(v);
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1", "y"].includes(s))     return true;
    if (["false", "no", "0", "n", ""].includes(s)) return false;
  }
  return null;
}

// ----------------------------------------------------------------------
// _coalesce_audit_items — multi-judge aggregation.
// ----------------------------------------------------------------------

export interface JudgeMeta {
  provider: string;
  model: string;
  /** "ok" | "parse_error" | "refusal" | "unknown" | etc. */
  status: string;
}

/** Per-judge result for one rubric item. The shape varies by branch
 *  (valid score, score-parse-error, pass-parse-error, no-response). */
export type PerJudgeEntry =
  | { provider: string; model: string; status: string }
  | { provider: string; model: string; score: number; pass: boolean; rationale: string }
  | { provider: string; model: string; status: "score_parse_error"; raw_score: unknown }
  | { provider: string; model: string; status: "pass_parse_error";  raw_pass:  unknown };

export interface CoalescedItem {
  id: string;
  description: string;
  severity: RubricSeverity;
  score: number;
  pass: boolean;
  stddev: number | null;
  disagreement_score: number;
  disputed: boolean;
  flags: string[];
  obvious_failure_judges: string[];
  valid_judges: number;
  per_judge: PerJudgeEntry[];
}

export interface CoalesceFlags {
  obvious_failures: string[];
  disagreements: string[];
  audit_process_failure: boolean;
  judges_stats: {
    total: number;
    valid: number;
    parse_errors: number;
    refusals: number;
  };
}

/** Aggregate a list of per-judge audit objects into one set of items.
 *  Mirrors `_coalesce_audit_items` byte-for-byte. */
export function coalesceAuditItems(args: {
  rubricItems: readonly RubricItem[];
  perJudgeObj: readonly (Record<string, unknown> | null)[];
  perJudgeMeta: readonly JudgeMeta[];
  strictMode: boolean;
}): { items: CoalescedItem[]; flags: CoalesceFlags } {
  const { rubricItems, perJudgeObj, perJudgeMeta, strictMode } = args;
  const nTotal = perJudgeObj.length;
  const nValid = perJudgeObj.filter(
    (o) => o !== null && typeof o === "object" && Array.isArray((o as Record<string, unknown>)["items"]),
  ).length;
  const parseErrors = perJudgeMeta.filter((m) => m.status === "parse_error").length;
  const refusals    = perJudgeMeta.filter((m) => m.status === "refusal").length;
  // Audit process failure when fewer than ceil(N/2) judges produced
  // valid output (matches Python's math.ceil).
  const processFailure = nTotal === 0 || nValid < Math.ceil(nTotal / 2);

  const items: CoalescedItem[] = [];
  const obviousFailures: string[] = [];
  const disagreements: string[] = [];

  for (const ri of rubricItems) {
    const rid = ri.id;
    const severity =
      SEVERITY_ALIASES[String(ri.severity ?? "med").toLowerCase()] ?? "med";

    const perJudge: PerJudgeEntry[] = [];
    const scores: number[] = [];
    const passes: boolean[] = [];
    const offenders: string[] = [];
    let invalidJudgesThisItem = 0;

    for (let j = 0; j < perJudgeObj.length; j++) {
      const obj = perJudgeObj[j];
      const meta = perJudgeMeta[j] ?? { provider: "unknown", model: "unknown", status: "unknown" };
      const provider = meta.provider || "unknown";
      const model    = meta.model    || "unknown";
      const status   = meta.status    || "unknown";

      if (!obj || typeof obj !== "object" || !Array.isArray((obj as Record<string, unknown>)["items"])) {
        perJudge.push({ provider, model, status });
        invalidJudgesThisItem++;
        continue;
      }

      const innerItems = (obj as Record<string, unknown>)["items"] as unknown[];
      // Find the entry for this rubric id.
      const byId: Record<string, Record<string, unknown>> = {};
      for (const it of innerItems) {
        if (it && typeof it === "object") {
          const id = (it as Record<string, unknown>)["id"];
          if (typeof id === "string") byId[id] = it as Record<string, unknown>;
        }
      }
      const scored = byId[rid] ?? {};

      const rawScore = (scored as Record<string, unknown>)["score"];
      let s: number;
      if (rawScore === null || rawScore === undefined) {
        s = 0.0;
      } else if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
        s = rawScore;
      } else if (typeof rawScore === "string") {
        const parsed = Number(rawScore);
        if (Number.isFinite(parsed)) {
          s = parsed;
        } else {
          perJudge.push({
            provider, model,
            status: "score_parse_error",
            raw_score: rawScore,
          });
          invalidJudgesThisItem++;
          continue;
        }
      } else {
        perJudge.push({
          provider, model,
          status: "score_parse_error",
          raw_score: rawScore,
        });
        invalidJudgesThisItem++;
        continue;
      }

      const p = coercePass((scored as Record<string, unknown>)["pass"]);
      if (p === null) {
        perJudge.push({
          provider, model,
          status: "pass_parse_error",
          raw_pass: (scored as Record<string, unknown>)["pass"],
        });
        invalidJudgesThisItem++;
        continue;
      }

      scores.push(s);
      passes.push(p);
      perJudge.push({
        provider, model,
        score: s,
        pass: p,
        rationale: String((scored as Record<string, unknown>)["rationale"] ?? ""),
      });

      // Auto-flag: high < 0.3 or med < 0.2. Low never auto-flags.
      if (severity === "high" && s < AUDIT_OBVIOUS_FAILURE_HIGH) offenders.push(provider);
      else if (severity === "med" && s < AUDIT_OBVIOUS_FAILURE_MED) offenders.push(provider);
    }

    let med = 0.0;
    let passV = false;
    let sd: number | null = null;
    let disagreementScore = 0.0;
    let disputed = false;

    if (scores.length > 0) {
      med = median(scores);
      const passCount = passes.filter(Boolean).length;
      if (passCount > passes.length / 2) {
        passV = true;
      } else if (passCount < passes.length / 2) {
        passV = false;
      } else {
        passV = med >= 0.7;
      }
      if (strictMode) {
        // Every dispatched judge must pass (including those that didn't
        // produce a valid response for this item).
        passV = passes.length === nTotal && passes.length > 0 && passes.every(Boolean);
      }
      disagreementScore = Math.max(...scores) - Math.min(...scores);
      if (scores.length >= 3) {
        sd = pstdev(scores);
        disputed = sd > AUDIT_DISAGREEMENT_STDDEV;
      } else {
        sd = null;
        disputed = disagreementScore > AUDIT_DISAGREEMENT_RANGE;
      }
    }

    const flags: string[] = [];
    if (offenders.length > 0) {
      flags.push("obvious_failure");
      obviousFailures.push(rid);
    }
    if (disputed) {
      flags.push("disputed");
      disagreements.push(rid);
    }
    if (invalidJudgesThisItem > 0) flags.push("partial_judges");

    items.push({
      id: rid,
      description: ri.description,
      severity,
      score: roundTo(med, 4),
      pass: passV,
      stddev: sd !== null ? roundTo(sd, 4) : null,
      disagreement_score: roundTo(disagreementScore, 4),
      disputed,
      flags,
      obvious_failure_judges: Array.from(new Set(offenders)).sort(),
      valid_judges: scores.length,
      per_judge: perJudge,
    });
  }

  return {
    items,
    flags: {
      obvious_failures: obviousFailures,
      disagreements,
      audit_process_failure: processFailure,
      judges_stats: {
        total: nTotal,
        valid: nValid,
        parse_errors: parseErrors,
        refusals,
      },
    },
  };
}

// ----------------------------------------------------------------------
// Small math helpers — kept private to this module so they can match
// Python's statistics.median / pstdev / Number.toFixed semantics
// exactly without leaking unrelated helpers into the broader surface.
// ----------------------------------------------------------------------

/** Median matching `statistics.median`: for even-length, average of the
 *  two middle values; for odd, the middle. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0.0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Population standard deviation matching `statistics.pstdev`. */
function pstdev(xs: readonly number[]): number {
  if (xs.length === 0) return 0.0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varSum = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0);
  return Math.sqrt(varSum / xs.length);
}

function roundTo(x: number, n: number): number {
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(n));
}
