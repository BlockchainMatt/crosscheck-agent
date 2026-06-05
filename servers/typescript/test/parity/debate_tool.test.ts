// Cross-language parity: native tool_debate v1 (plain N-round + plain
// moderator synthesis).
//
// Same cassette pattern as confer/audit/pick — but each canned[name]
// is now a LIST so the round dispatch can pull a different response
// per turn (provider speaks once per round → consumes one entry from
// the list each time it's called). The moderator's synthesis call
// then consumes the next entry from its list.
//
// Special case: when the moderator is not in `canned`, Python falls
// through to `ALL_PROVIDERS.get(moderator_name)` which on the
// recording box IS configured. We mirror by reading the moderator's
// model from `expected.synthesis.model` and threading it into a
// synthetic provider whose canned response is `""` (matches what
// Python's empty-canned-dict produced).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runDebate } from "../../src/tools/debate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface DebateCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string[]>;
  expected: Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly DebateCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "debate_tool.json"), "utf8"),
) as Fixture;

/** Build a synthetic Provider whose .send() returns the canned text
 *  list one entry at a time (cursor per provider). When the list runs
 *  out, returns "". */
function syntheticPanelProvider(
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

/** Pull a model name for `provider` from the recorded fixture. Looks
 *  in transcript entries first, then synthesis, then falls back. */
function modelFor(c: DebateCase, provider: string): string {
  const transcript = (c.expected["transcript"] as { provider?: string; model?: string }[] | undefined) ?? [];
  for (const e of transcript) {
    if (e.provider === provider && typeof e.model === "string") return e.model;
  }
  const synth = c.expected["synthesis"] as { provider?: string; model?: string } | undefined;
  if (synth && synth.provider === provider && typeof synth.model === "string") return synth.model;
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

describe(`debate (v1 plain) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, texts] of Object.entries(c.canned)) {
        providers[name] = syntheticPanelProvider(name, modelFor(c, name), texts);
      }
      // If the moderator isn't in canned, add a synthetic that emits "".
      const moderatorName = c.args["moderator"] as string | undefined;
      if (moderatorName && !providers[moderatorName.toLowerCase()]) {
        const synth = c.expected["synthesis"] as { provider?: string; model?: string } | undefined;
        if (synth?.provider === moderatorName) {
          providers[moderatorName.toLowerCase()] =
            syntheticPanelProvider(moderatorName, synth.model ?? `${moderatorName}-default`, [""]);
        }
      }

      const actual = (await runDebate(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
