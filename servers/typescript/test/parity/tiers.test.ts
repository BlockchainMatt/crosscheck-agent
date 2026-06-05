// Cross-language parity: tier ladder + cheap-mode selection.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { PricingDoc } from "../../src/core/pricing.js";
import {
  selectForDifficulty,
  tierLadder,
  typicalCallCost,
  type DifficultyTier,
} from "../../src/core/tiers.js";

interface TypicalCase {
  label: string;
  provider: string;
  model: string;
  expected: number;
}

interface SelectCase {
  label: string;
  tier: string;
  exclude: readonly string[] | null;
  allow_only: readonly string[] | null;
  available: readonly string[];
  weights: Readonly<Record<string, number>>;
  expected: { pick: { provider: string; model: string } | null; reason: string | null };
}

interface Fixture {
  module: string;
  pricing_doc: PricingDoc;
  ladder_expected: Record<string, { provider: string; model: string }[]>;
  typical_cases: readonly TypicalCase[];
  select_cases: readonly SelectCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/tiers.json", import.meta.url), "utf8"),
) as Fixture;

describe("parity: tiers (1 ladder + N typical + N select)", () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("tiers");
  });

  it("tierLadder() byte-equal", () => {
    expect(tierLadder(fixture.pricing_doc)).toEqual(fixture.ladder_expected);
  });

  it.each(fixture.typical_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(typicalCallCost(fixture.pricing_doc, {
        provider: c.provider, model: c.model,
      })).toBe(c.expected);
    },
  );

  it.each(fixture.select_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const result = selectForDifficulty({
        pricing:            fixture.pricing_doc,
        tier:               c.tier as DifficultyTier,
        exclude:            c.exclude ?? undefined,
        allowOnly:          c.allow_only ?? undefined,
        availableProviders: new Set(c.available),
        providerWeights:    c.weights,
      });
      expect(result.pick).toEqual(c.expected.pick);
      if (result.pick !== null) {
        // Successful picks have a null reason.
        expect(result.reason).toBeNull();
      } else {
        // No-available cases: Python's reason embeds `list(set)` whose
        // iteration order depends on PYTHONHASHSEED — not stable across
        // runs. The contract is pick=null + non-empty reason; the prose
        // is descriptive only.
        expect(c.expected.reason).toBeTypeOf("string");
        expect(result.reason).toBeTypeOf("string");
        expect(result.reason!.length).toBeGreaterThan(0);
      }
    },
  );
});
