// Cross-language parity: error envelope.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { error, type ErrorKind } from "../../src/core/error.js";

interface ErrorCase {
  label: string;
  code: string;
  message: string;
  options: {
    kind?: ErrorKind;
    hint?: string;
    transient?: boolean;
    extra?: Record<string, unknown>;
  };
  expected: Record<string, unknown>;
}
interface Fixture { module: string; case_count: number; cases: readonly ErrorCase[] }

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/error.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: error (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("error");
  });
  it.each(fixture.cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(error(c.code, c.message, c.options)).toEqual(c.expected);
    },
  );
});
