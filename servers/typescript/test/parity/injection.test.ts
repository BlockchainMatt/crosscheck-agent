// Cross-language parity: neutralizeInjection.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { neutralizeInjection } from "../../src/core/injection.js";

interface InjectionCase {
  label: string;
  input: string;
  expected: string;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly InjectionCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/injection.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: injection (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("injection");
  });
  it.each(fixture.cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(neutralizeInjection(c.input)).toBe(c.expected);
    },
  );
});
