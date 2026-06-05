// Cross-language parity: native tool_audit (single-mode, Phase 5 part 4).
//
// Same cassette pattern as pick — see test/parity/pick.test.ts. The
// fixture records the canned LLM response (per provider) plus the
// sanitized Python output; the TS test wires synthetic Providers and
// asserts byte-equal on the deterministic fields after the same
// sanitizer.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runAudit } from "../../src/tools/audit.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface AuditCase {
  label:    string;
  args:     Record<string, unknown>;
  canned:   Record<string, string>;
  expected: Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly AuditCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "audit_tool.json"), "utf8"),
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

/** Mirror whatever model Python's Provider had on the fixture-recording
 *  box. The auditor envelope (`{provider, model}`) is part of the
 *  byte-equal contract; without this our synthetic provider would
 *  emit "anthropic-default" while Python recorded "claude-opus-4-7"
 *  (or whatever was in the recording env). */
function modelFor(c: AuditCase, provider: string): string {
  const auditor = c.expected["auditor"] as { provider?: string; model?: string } | undefined;
  if (auditor && auditor.provider === provider && typeof auditor.model === "string") {
    return auditor.model;
  }
  return `${provider}-default`;
}

function sanitize(out: Record<string, unknown>): Record<string, unknown> {
  const r = { ...out };
  for (const k of ["budget", "session", "usage", "timing", "run_summary",
                   "transcript_path", "_suppress_run_summary",
                   "session_memory_marked_stale"]) {
    delete r[k];
  }
  return r;
}

describe(`audit (single-mode) parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, async () => {
      const providers: Record<string, Provider> = {};
      for (const [name, text] of Object.entries(c.canned)) {
        providers[name] = syntheticProvider(name, modelFor(c, name), text);
      }
      const actual = (await runAudit(c.args, { providers })) as Record<string, unknown>;
      expect(canonicalize(sanitize(actual))).toBe(canonicalize(sanitize(c.expected)));
    });
  }
});
