// Cross-language parity: native tool_triangulate v1.
//
// Triangulate wraps coordinate, so cassette shape mirrors coordinate's:
// canned[name] is a list consumed in role-step order. The test threads
// the recorded model from the coordinate-output answer envelopes
// (proposal_answer, critique_answers, synthesis_answer) into the
// synthetic providers — but triangulate strips those raw answers from
// its own envelope. We look in coord's nested data via providers_used
// + roles.proposer/synthesizer to figure out provider order, and pull
// model names by matching against any answer envelopes we can find.
//
// In practice, every panelist's first canned response is a proposer-
// shape JSON or a critic-shape JSON, both validated by their RoleTurn
// schemas. The synthesizer's call goes to whichever provider plays
// that role. We rebuild the synth providers identically and assert
// byte-equal on the triangulate envelope.
//
// Stripped on both sides: budget, session, usage, timing,
// run_summary, transcript_path, canary_leaks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runTriangulate } from "../../src/tools/triangulate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface TriCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string[]>;
  expected: Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly TriCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "triangulate_tool.json"), "utf8"),
) as Fixture;

function syntheticProvider(
  name: string, model: string, cannedTexts: readonly string[],
): Provider {
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

/** Triangulate's envelope only carries `panel[].provider` and
 *  `roles`, NOT the inner answer envelopes. We don't have model
 *  names in the expected output at all (Python strips them too).
 *  Use a stable per-provider default — and matching by name keeps
 *  output byte-equal because triangulate doesn't emit model fields. */
function modelFor(provider: string): string {
  return ({
    anthropic: "claude-opus-4-7",
    openai:    "gpt-5",
    xai:       "grok-4-latest",
    gemini:    "gemini-2.5-pro",
  } as Record<string, string>)[provider] ?? `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "transcript_path", "canary_leaks",
                   "_suppress_run_summary"]) {
    delete r[k];
  }
  return r;
}

describe(`triangulate (v1) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, texts] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(name), texts);
      }
      const actual = (await runTriangulate(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
