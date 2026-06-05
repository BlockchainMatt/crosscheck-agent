// Cross-language parity: wrapUntrusted + scanCanaryLeaks.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mintCanary, scanCanaryLeaks, wrapUntrusted } from "../../src/core/canary.js";

interface WrapCase {
  label: string;
  content: string;
  canary: string | null;
  expected: string;
}
interface ScanCase {
  label: string;
  canary: string;
  answers: readonly unknown[];
  expected: {
    sanitized: readonly unknown[];
    leaks: readonly { provider: unknown; model: unknown; count: number }[];
  };
}
interface Fixture {
  module: string;
  case_count: number;
  wrap_cases: readonly WrapCase[];
  scan_cases: readonly ScanCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/canary.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: canary (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("canary");
  });

  it.each(fixture.wrap_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(wrapUntrusted(c.content, c.canary)).toBe(c.expected);
    },
  );

  it.each(fixture.scan_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const { sanitized, leaks } = scanCanaryLeaks(
        c.canary,
        c.answers as readonly Record<string, unknown>[],
      );
      expect(sanitized).toEqual(c.expected.sanitized);
      expect(leaks).toEqual(c.expected.leaks);
    },
  );

  // Non-parity sanity for mintCanary (real time + RNG, can't fixture).
  it("mintCanary produces a 26-char CC_CANARY_<16HEX-UPPER> nonce", () => {
    const c = mintCanary();
    expect(c).toMatch(/^CC_CANARY_[0-9A-F]{16}$/);
    expect(c.length).toBe("CC_CANARY_".length + 16);
  });
  it("mintCanary yields different values across calls", () => {
    const a = mintCanary();
    const b = mintCanary();
    expect(a).not.toBe(b);
  });
});
