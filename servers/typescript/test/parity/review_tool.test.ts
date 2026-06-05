// Cross-language parity: native tool_review (wrapper over confer).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runReview } from "../../src/tools/review.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface ReviewCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string>;
  expected: Record<string, unknown>;
}
interface Fixture { module: string; case_count: number; cases: readonly ReviewCase[] }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "review_tool.json"), "utf8"),
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

function modelFor(c: ReviewCase, provider: string): string {
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

describe(`review (wraps confer) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, text] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), text);
      }
      const actual = (await runReview(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
