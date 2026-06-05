// Cross-language parity: audit rubric defaults + coercePass +
// coalesceAuditItems.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  coalesceAuditItems,
  coercePass,
  DEFAULT_AUDIT_RUBRICS,
  type JudgeMeta,
  type RubricItem,
} from "../../src/core/audit.js";

interface CoerceCase {
  label: string;
  input: unknown;
  expected: boolean | null;
}

interface CoalesceCase {
  label: string;
  rubric: readonly RubricItem[];
  per_judge_obj: readonly (Record<string, unknown> | null)[];
  per_judge_meta: readonly JudgeMeta[];
  strict_mode: boolean;
  expected: unknown;
}

interface Fixture {
  module: string;
  rubric_expected: readonly RubricItem[];
  coerce_cases: readonly CoerceCase[];
  coalesce_cases: readonly CoalesceCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/audit.json", import.meta.url), "utf8"),
) as Fixture;

describe("parity: audit", () => {
  it("DEFAULT_AUDIT_RUBRICS byte-equal", () => {
    expect(DEFAULT_AUDIT_RUBRICS).toEqual(fixture.rubric_expected);
  });

  it.each(fixture.coerce_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(coercePass(c.input)).toBe(c.expected);
    },
  );

  it.each(fixture.coalesce_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const r = coalesceAuditItems({
        rubricItems:  c.rubric,
        perJudgeObj:  c.per_judge_obj,
        perJudgeMeta: c.per_judge_meta,
        strictMode:   c.strict_mode,
      });
      expect(r).toEqual(c.expected);
    },
  );
});
