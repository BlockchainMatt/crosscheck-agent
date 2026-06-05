// Cross-language parity: native tool_plan v1 (wrapper over debate).
//
// Plan delegates to debate; the parity gate is that the prompt
// construction (GOAL / CONSTRAINTS f-string) makes it through and
// the debate envelope round-trips byte-equal.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runPlan } from "../../src/tools/plan.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface PlanCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string[]>;
  expected: Record<string, unknown>;
}
interface Fixture { module: string; case_count: number; cases: readonly PlanCase[] }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "plan_tool.json"), "utf8"),
) as Fixture;

function syntheticProvider(name: string, model: string, texts: readonly string[]): Provider {
  let i = 0;
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => {
      const text = i < texts.length ? texts[i]! : "";
      i++;
      return {
        text, attempts: 1,
        usage: {
          ...emptyUsage(name, model, args.purpose ?? "worker"),
          prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
          estimated: false,
        },
      };
    },
  };
}

/** Mirror debate's modelFor pattern — pull model from transcript or synthesis. */
function modelFor(c: PlanCase, provider: string): string {
  const transcript = (c.expected["transcript"] as { provider?: string; model?: string }[] | undefined) ?? [];
  for (const e of transcript) {
    if (e.provider === provider && typeof e.model === "string") return e.model;
  }
  const synth = c.expected["synthesis"] as { provider?: string; model?: string } | undefined;
  if (synth?.provider === provider && typeof synth.model === "string") return synth.model;
  return `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "transcript_path", "claims", "agreement_check",
                   "early_stopped", "early_stopped_round", "rounds_skipped",
                   "synthesis_structured", "synthesis_errors",
                   "_suppress_run_summary"]) {
    delete r[k];
  }
  const t = (r["transcript"] as Record<string, unknown>[] | undefined) ?? [];
  r["transcript"] = t.map((e) => {
    const b = { ...e };
    for (const k of ["elapsed_ms", "cpu_ms", "cache_hit", "timing"]) delete b[k];
    return b;
  });
  const s = r["synthesis"] as Record<string, unknown> | null | undefined;
  if (s && typeof s === "object") {
    const b = { ...s };
    for (const k of ["elapsed_ms", "cpu_ms", "cache_hit", "timing"]) delete b[k];
    r["synthesis"] = b;
  }
  return r;
}

describe(`plan (wraps debate) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, texts] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), texts);
      }
      const actual = (await runPlan(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
