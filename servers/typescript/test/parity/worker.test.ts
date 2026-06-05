// Cross-language parity: worker tool-use pure-function pieces.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  extractToolCall,
  workerToolCostCapDefaults,
  workerToolCostCapRefusal,
  workerToolCostObserved,
  workerToolsRefusal,
  workerToolsSystemHint,
  wrapToolResult,
} from "../../src/core/worker.js";

interface CapCase {
  label: string;
  caller_cap: unknown;
  caller_mode: unknown;
  cfg: Record<string, unknown> | null;
  expected: { cap_usd: number | null; mode: string };
}

interface ObservedCase {
  label: string;
  input: unknown;
  expected: number;
}

interface HintCase {
  label: string;
  input: readonly string[];
  expected: string;
}

interface ExtractCase {
  label: string;
  input: unknown;
  expected: { call: { name: string; args?: Record<string, unknown> } | null; error: string | null };
}

interface WrapCase {
  label: string;
  name: string;
  content: string;
  expected: string;
}

interface RefusalCase {
  label: string;
  name: string;
  reason: string;
  hint: string | null;
  schema_error: string | null;
  expected: string;
}

interface CapRefusalCase {
  label: string;
  observed: number;
  cap: number;
  expected: string;
}

interface Fixture {
  module: string;
  case_count: number;
  cap_cases: readonly CapCase[];
  observed_cases: readonly ObservedCase[];
  hint_cases: readonly HintCase[];
  extract_cases: readonly ExtractCase[];
  wrap_cases: readonly WrapCase[];
  refusal_cases: readonly RefusalCase[];
  capref_cases: readonly CapRefusalCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/worker.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: worker (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("worker");
  });

  it.each(fixture.cap_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const { capUsd, mode } = workerToolCostCapDefaults(
        c.caller_cap,
        c.caller_mode,
        c.cfg ?? undefined,
      );
      expect(capUsd).toBe(c.expected.cap_usd);
      expect(mode).toBe(c.expected.mode);
    },
  );

  it.each(fixture.observed_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      // The Python fixture replaces NaN inputs with a sentinel string
      // because JSON can't carry NaN. The function returns 0 in both
      // cases (NaN coerces to 0 via Number.isFinite check). Both paths
      // are equivalent under our contract.
      const input =
        typeof c.input === "object" && c.input !== null &&
        (c.input as { usage?: { cost_usd?: unknown } })?.usage?.cost_usd === "NaN_SENTINEL"
          ? { usage: { cost_usd: Number.NaN } }
          : c.input;
      expect(workerToolCostObserved(input)).toBe(c.expected);
    },
  );

  it.each(fixture.hint_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(workerToolsSystemHint(c.input)).toBe(c.expected);
    },
  );

  it.each(fixture.extract_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const r = extractToolCall(c.input);
      // Python returns (None, error) for tag-with-bad-JSON; structure
      // matches our {call:null, error}. Compare both fields.
      expect(r.call).toEqual(c.expected.call);
      // JSON-parse error messages vary slightly between Python's json
      // and JS JSON.parse. Match the prefix instead of the full string.
      if (c.expected.error === null) {
        expect(r.error).toBeNull();
      } else if (c.expected.error.startsWith("tool_call body is not valid JSON")) {
        expect(r.error).toMatch(/^tool_call body is not valid JSON/);
      } else {
        expect(r.error).toBe(c.expected.error);
      }
    },
  );

  it.each(fixture.wrap_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(wrapToolResult(c.name, c.content)).toBe(c.expected);
    },
  );

  it.each(fixture.refusal_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const opts: { hint?: string; schemaError?: string } = {};
      if (c.hint)         opts.hint        = c.hint;
      if (c.schema_error) opts.schemaError = c.schema_error;
      expect(workerToolsRefusal(c.name, c.reason, opts)).toBe(c.expected);
    },
  );

  it.each(fixture.capref_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(workerToolCostCapRefusal(c.observed, c.cap)).toBe(c.expected);
    },
  );
});
