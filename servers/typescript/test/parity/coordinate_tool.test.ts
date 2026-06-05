// Cross-language parity: native tool_coordinate v1 (proposer →
// critics → synthesizer).
//
// Same cassette pattern as debate. Each canned[name] is a LIST,
// consumed in the order the provider is called across the three
// role steps. Model name threaded from expected.proposal_answer /
// critique_answers / synthesis_answer.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runCoordinate } from "../../src/tools/coordinate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface CoordinateCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string[]>;
  expected: Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly CoordinateCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "coordinate_tool.json"), "utf8"),
) as Fixture;

function syntheticProvider(name: string, model: string, cannedTexts: readonly string[]): Provider {
  let cursor = 0;
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => {
      const text = cursor < cannedTexts.length ? cannedTexts[cursor]! : "";
      cursor++;
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

/** Pull the model for `provider` from any of the recorded answer
 *  envelopes. Lets the synthetic provider emit Python's model name
 *  so the byte-equal contract holds on every `model` field. */
function modelFor(c: CoordinateCase, provider: string): string {
  const candidates: Array<{ provider?: string; model?: string } | undefined> = [
    c.expected["proposal_answer"]  as { provider?: string; model?: string } | undefined,
    c.expected["synthesis_answer"] as { provider?: string; model?: string } | undefined,
    ...(((c.expected["critique_answers"] as Array<{ provider?: string; model?: string }>) ?? [])),
  ];
  for (const a of candidates) {
    if (a && a.provider === provider && typeof a.model === "string") return a.model;
  }
  return `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "transcript_path", "canary_leaks",
                   "_suppress_run_summary"]) {
    delete r[k];
  }
  for (const k of ["proposal_answer", "synthesis_answer"]) {
    const a = r[k] as Record<string, unknown> | undefined | null;
    if (a && typeof a === "object") {
      const b = { ...a };
      for (const kk of ["elapsed_ms", "cpu_ms", "cache_hit", "timing"]) delete b[kk];
      r[k] = b;
    }
  }
  const ca = (r["critique_answers"] as Record<string, unknown>[] | undefined) ?? [];
  r["critique_answers"] = ca.map((a) => {
    const b = { ...a };
    for (const kk of ["elapsed_ms", "cpu_ms", "cache_hit", "timing"]) delete b[kk];
    return b;
  });
  return r;
}

describe(`coordinate (v1 plain) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, texts] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), texts);
      }
      const actual = (await runCoordinate(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
