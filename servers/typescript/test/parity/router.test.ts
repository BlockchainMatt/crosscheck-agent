// Cross-language parity: smart router (score + recommend).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  routerRecommend,
  routerScore,
  type RouterStats,
} from "../../src/core/router.js";

interface ScoreCase {
  label: string;
  stats: Partial<RouterStats>;
  min_cost: number;
  max_cost: number;
  expected: number;
}

interface RecommendCase {
  label: string;
  purpose: string;
  n: number;
  exclude: readonly string[] | null;
  stats: Readonly<Record<string, RouterStats>>;
  provider_weights: Readonly<Record<string, number>>;
  provider_models: Readonly<Record<string, string>>;
  panel: readonly string[];
  expected: unknown;
}

interface Fixture {
  module: string;
  case_count: number;
  score_cases: readonly ScoreCase[];
  recommend_cases: readonly RecommendCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/router.json", import.meta.url), "utf8"),
) as Fixture;

function withDefaults(p: Partial<RouterStats>): RouterStats {
  return {
    provider:         p.provider ?? "",
    calls:            p.calls ?? 0,
    errors:           p.errors ?? 0,
    error_rate:       p.error_rate ?? 0.0,
    avg_total_tokens: p.avg_total_tokens ?? 0.0,
    avg_cost_usd:     p.avg_cost_usd ?? 0.0,
    avg_wall_ms:      p.avg_wall_ms ?? 0.0,
  };
}

describe(`parity: router (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("router");
  });

  it.each(fixture.score_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(routerScore(withDefaults(c.stats), c.min_cost, c.max_cost))
        .toBe(c.expected);
    },
  );

  it.each(fixture.recommend_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const result = routerRecommend({
        purpose:          c.purpose,
        n:                c.n,
        exclude:          c.exclude ?? undefined,
        stats:            c.stats,
        panel:            c.panel,
        providerWeights:  c.provider_weights,
        providerModels:   c.provider_models,
      });
      expect(result).toEqual(c.expected);
    },
  );
});
