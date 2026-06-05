// Cross-language parity: aggregateUsage rollup.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { aggregateUsage, type Usage } from "../../src/core/usage.js";

interface UsageCase {
  label: string;
  usages: readonly Usage[];
  expected: unknown;
}
interface Fixture { module: string; case_count: number; cases: readonly UsageCase[] }

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/usage.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: usage (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("usage");
  });
  it.each(fixture.cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      // Python's aggregate_usage emits `total_tokens` as the to_dict()
      // value when non-zero, OR (prompt+completion) when zero. Our
      // aggregateUsage uses the input record's total_tokens as-is for
      // by_call (matching Python). Confirm structurally equal.
      expect(aggregateUsage(c.usages)).toEqual(c.expected);
    },
  );
});
