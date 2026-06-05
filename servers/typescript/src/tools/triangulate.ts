// Native TS port of Python's `tool_triangulate` — Phase 5 part 9.
//
// Thin wrapper over `coordinate`: maps args, calls runCoordinate,
// then reshapes the output as a consensus + minority report with
// per-provider weights drawn from accumulated ballot stats.
//
// SCOPE for v1:
//   - Delegates to native runCoordinate. If coordinate decides to
//     defer to bridge (e.g. untrusted_input opt set), this defers
//     too — the triangulate envelope just wraps whatever coordinate
//     returns.
//   - providerWeights = 1.0 for every panel member. Python's
//     `_provider_weights` reads from `provider_stats` DB; on a fresh
//     DB (or until the DB layer ports natively) it returns 1.0 for
//     every entry anyway. Parity fixtures patch the stats helper to
//     return empty, so the recorded weights match.
//
// Output envelope: matches Python tool_triangulate exactly (sans the
// tail fields we strip in parity: budget, session, usage, timing,
// run_summary, transcript_path).

import { runCoordinate, type RunCoordinateOptions } from "./coordinate.js";

import type { Provider } from "../providers/types.js";
import type { BridgeHandle } from "../bridge/index.js";

export interface RunTriangulateOptions extends RunCoordinateOptions {
  /** Future hook for threading DB-backed weights. v1 ignores this and
   *  emits 1.0 for every panel member (matches fresh-DB Python). */
  providerWeights?: Readonly<Record<string, number>>;
}

export async function runTriangulate(
  args: Record<string, unknown>,
  opts: RunTriangulateOptions,
): Promise<Record<string, unknown>> {
  const question = typeof args["question"] === "string"
    ? args["question"]
    : String(args["question"] ?? "");
  const context = typeof args["context"] === "string" ? args["context"] : "";

  // Build coordinate args (Python's exact set — providers, session_id,
  // untrusted_input, context, and the question mapped to `topic`).
  const coordArgs: Record<string, unknown> = {
    topic:          question,
    context,
    untrusted_input: Boolean(args["untrusted_input"]),
  };
  if (args["providers"]  !== undefined) coordArgs["providers"]  = args["providers"];
  if (args["session_id"] !== undefined) coordArgs["session_id"] = args["session_id"];

  const coord = await runCoordinate(coordArgs, opts);

  // Coordinate returned an error envelope → return it verbatim
  // (Python: `if "error" in coord: return coord`).
  if (typeof coord["error"] === "string") return coord;

  const synth = (coord["synthesis_structured"] as Record<string, unknown> | null) ?? {};
  const consensus           = typeof synth["consensus"] === "string"
                                ? synth["consensus"]
                                : "(no consensus produced)";
  const weightedConfidence  = synth["weighted_confidence"] ?? null;
  const keyClaims           = Array.isArray(synth["key_claims"])     ? synth["key_claims"]     : [];
  const dissent             = Array.isArray(synth["dissent"])         ? synth["dissent"]         : [];
  const openQuestions       = Array.isArray(synth["open_questions"]) ? synth["open_questions"] : [];

  // Build the panel name set (sorted) from coord.roles.
  const roles = coord["roles"] as {
    proposer:    string;
    critics:     string[];
    synthesizer: string;
  };
  const panelSet = new Set<string>([
    roles.proposer, roles.synthesizer, ...roles.critics,
  ]);
  const panelNames = [...panelSet].sort();

  // v1: 1.0 per provider — matches Python's fresh-DB output. Future:
  // thread real weights when the DB layer ports.
  const weights: Record<string, number> = {};
  for (const n of panelNames) {
    weights[n] = opts.providerWeights?.[n] ?? 1.0;
  }

  // Minority report formatting — byte-equal with Python's f-string.
  const minorityLines: string[] = [];
  for (const d of dissent as Array<Record<string, unknown>>) {
    const provs = Array.isArray(d["providers"]) && (d["providers"] as string[]).length > 0
      ? (d["providers"] as string[]).join(", ")
      : "(unspecified)";
    const rationale = typeof d["rationale"] === "string" ? d["rationale"] : "";
    const claim     = typeof d["claim"]     === "string" ? d["claim"]     : "";
    let line = `- ${claim} — voiced by ${provs}`;
    if (rationale) line += `: ${rationale}`;
    minorityLines.push(line);
  }
  const minorityReport = minorityLines.length > 0
    ? minorityLines.join("\n")
    : "(no dissent recorded)";

  const result: Record<string, unknown> = {
    tool: "triangulate",
    question,
    consensus,
    weighted_confidence: weightedConfidence,
    key_claims:          keyClaims,
    dissent,
    minority_report:     minorityReport,
    open_questions:      openQuestions,
    panel:               panelNames.map((n) => ({ provider: n, weight: weights[n] })),
    providers_used:      panelNames,
    roles,
    synthesis_errors:    coord["synthesis_errors"] ?? [],
  };
  // Pass-through optional fields from coord, matching Python's order.
  for (const k of ["budget", "session", "transcript_path",
                   "blocked_by_allowlist", "skipped_unknown_providers"]) {
    if (k in coord) result[k] = coord[k];
  }
  return result;
}

// Bridge-side fallback isn't a separate path here — coordinate decides
// when to defer; triangulate just inherits whatever coordinate
// returns. (When coordinate returns the bridge's envelope, that's a
// debate output, not a triangulate output — but the tail-field shape
// matches closely enough that callers see the deferral as "got
// coordinate-shape back, no triangulate-shape." Triangulate-on-bridge
// directly is reachable through tool registration; see
// src/tools/index.ts.)

export const __test_internals = {
  // Kept for symmetry with sibling tools. Triangulate has no pure
  // helpers worth exporting beyond what coordinate already exposes.
  _: null as unknown,
};

void ({} as Provider);   // keep the type import live
void ({} as BridgeHandle);
