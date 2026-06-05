// Cross-language parity: native tool_critique.
//
// Cassette pattern: one canned response per provider (single call per
// panelist; no rounds). Model name threaded from the recorded
// per_provider rows.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runCritique } from "../../src/tools/critique.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface CritiqueCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string>;
  expected: Record<string, unknown>;
}
interface Fixture { module: string; case_count: number; cases: readonly CritiqueCase[] }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "critique_tool.json"), "utf8"),
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

/** Recover the per-provider model from the expected envelope. */
function modelFor(c: CritiqueCase, provider: string): string {
  const perProvider = (c.expected["per_provider"] as { provider?: string; model?: string }[] | undefined) ?? [];
  for (const pp of perProvider) {
    if (pp.provider === provider && typeof pp.model === "string") return pp.model;
  }
  return `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "canary_leaks", "_suppress_run_summary"]) {
    delete r[k];
  }
  return r;
}

describe(`critique parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, text] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), text);
      }
      const actual = (await runCritique(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
