// Cross-language parity: native tool_confer v1 (plain panel-call path).
//
// Cassette pattern — same shape as pick + audit. Per-provider model is
// threaded from the recorded fixture (Python's Provider.model varies
// by recording env) into the synthetic Provider so the byte-equal
// contract holds on answer.{provider, model}.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runConfer } from "../../src/tools/confer.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface ConferCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string>;
  expected: Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly ConferCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "confer_tool.json"), "utf8"),
) as Fixture;

function syntheticProvider(name: string, model: string, cannedText: string): Provider {
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: cannedText, attempts: 1,
      usage: {
        ...emptyUsage(name, model, args.purpose ?? "worker"),
        prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
        estimated: false,
      },
    }),
  };
}

/** Pull the recorded model for a given provider name from
 *  `expected.answers[*].model` so the synthetic Provider emits the
 *  same identity Python did. Falls back to `${name}-default` for
 *  providers that don't appear in the answers list (e.g. when an
 *  error-envelope branch returns early). */
function modelFor(c: ConferCase, provider: string): string {
  const answers = (c.expected["answers"] as { provider?: string; model?: string }[] | undefined) ?? [];
  for (const a of answers) {
    if (a.provider === provider && typeof a.model === "string") return a.model;
  }
  return `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "transcript_path", "transcript", "_suppress_run_summary"]) {
    delete r[k];
  }
  const ans = (r["answers"] as Record<string, unknown>[] | undefined) ?? [];
  r["answers"] = ans.map((a) => {
    const b = { ...a };
    for (const k of ["elapsed_ms", "cpu_ms", "cache_hit", "timing"]) delete b[k];
    return b;
  });
  return r;
}

describe(`confer (plain panel) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, text] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), text);
      }
      const actual = (await runConfer(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
