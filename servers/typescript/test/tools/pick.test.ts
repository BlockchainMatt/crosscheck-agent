// Native-only behavior tests for runPick + its pure helpers.
//
// Cross-language parity is covered by test/parity/pick.test.ts. This
// file covers the pure helpers (normalizePickInput, stddev, pyRound,
// resolveProviders, pickTopOption) and the synthesised provider flow.

import { describe, expect, it } from "vitest";

import { emptyUsage } from "../../src/core/usage.js";
import {
  __test_internals,
  normalizePickInput,
  runPick,
  stddev,
} from "../../src/tools/pick.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { pickTopOption, resolveProviders, pyRound } = __test_internals;

function fakeProvider(name: string, cannedText: string): Provider {
  return {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: cannedText, attempts: 1,
      usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker"),
    }),
  };
}

describe("normalizePickInput", () => {
  it("string option → {name}", () => {
    const { options } = normalizePickInput(["Pizza"], [{ name: "speed" }]);
    expect(options).toEqual([{ name: "Pizza" }]);
  });

  it("dict option preserves description", () => {
    const { options } = normalizePickInput(
      [{ name: "Sushi", description: "raw fish" }],
      [{ name: "speed" }],
    );
    expect(options).toEqual([{ name: "Sushi", description: "raw fish" }]);
  });

  it("dict option without description → '' (Python parity)", () => {
    const { options } = normalizePickInput(
      [{ name: "Sushi" }],
      [{ name: "speed" }],
    );
    expect(options).toEqual([{ name: "Sushi", description: "" }]);
  });

  it("malformed option (no name) → skipped", () => {
    const { options } = normalizePickInput(
      [{ description: "ghost" }, "good"],
      [{ name: "speed" }],
    );
    expect(options).toEqual([{ name: "good" }]);
  });

  it("criterion defaults weight to 1.0, description to ''", () => {
    const { criteria } = normalizePickInput(
      ["x"],
      [{ name: "perf" }],
    );
    expect(criteria).toEqual([{ name: "perf", weight: 1.0, description: "" }]);
  });

  it("criterion preserves weight + description", () => {
    const { criteria } = normalizePickInput(
      ["x"],
      [{ name: "perf", weight: 2.5, description: "raw speed" }],
    );
    expect(criteria).toEqual([{ name: "perf", weight: 2.5, description: "raw speed" }]);
  });

  it("malformed criterion (no name) → skipped", () => {
    const { criteria } = normalizePickInput(
      ["x"],
      [{ weight: 1.0 }, { name: "ok" }],
    );
    expect(criteria).toEqual([{ name: "ok", weight: 1.0, description: "" }]);
  });

  it("non-list inputs → empty lists", () => {
    const out = normalizePickInput("nope", null);
    expect(out).toEqual({ options: [], criteria: [] });
  });
});

describe("stddev (population)", () => {
  it("empty list → 0", () => { expect(stddev([])).toBe(0); });
  it("single value → 0", () => { expect(stddev([5])).toBe(0); });
  it("two equal values → 0", () => { expect(stddev([5, 5])).toBe(0); });
  it("[1, 3] → 1", () => { expect(stddev([1, 3])).toBeCloseTo(1, 10); });
  it("[2, 4, 4, 4, 5, 5, 7, 9] → 2 (textbook example)", () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });
});

describe("pyRound (banker's rounding)", () => {
  it("round half to even", () => {
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(3.5, 0)).toBe(4);
  });
  it("normal halves go up", () => {
    expect(pyRound(0.6, 0)).toBe(1);
    expect(pyRound(0.4, 0)).toBe(0);
  });
  it("multi-decimal", () => {
    expect(pyRound(1.234567, 4)).toBe(1.2346);
    expect(pyRound(0.99995,  4)).toBe(1.0);
  });
  it("non-finite passes through", () => {
    expect(Number.isNaN(pyRound(NaN, 4))).toBe(true);
    expect(pyRound(Infinity, 4)).toBe(Infinity);
  });
});

describe("resolveProviders", () => {
  const av = {
    anthropic: fakeProvider("anthropic", ""),
    openai:    fakeProvider("openai", ""),
  };

  it("null names → use all available, in insertion order", () => {
    const r = resolveProviders(null, av, null);
    expect(r.selected.map((p) => p.name)).toEqual(["anthropic", "openai"]);
    expect(r.unknown).toEqual([]);
  });

  it("empty array → use all", () => {
    const r = resolveProviders([], av, null);
    expect(r.selected.map((p) => p.name)).toEqual(["anthropic", "openai"]);
  });

  it("named subset, preserves order, dedupes", () => {
    const r = resolveProviders(
      ["openai", "anthropic", "openai", "  ANTHROPIC  "],
      av, null,
    );
    expect(r.selected.map((p) => p.name)).toEqual(["openai", "anthropic"]);
  });

  it("unknown name → caught in `unknown`", () => {
    const r = resolveProviders(["anthropic", "zzz"], av, null);
    expect(r.selected.map((p) => p.name)).toEqual(["anthropic"]);
    expect(r.unknown).toEqual(["zzz"]);
  });

  it("allowlist filters out non-listed", () => {
    const r = resolveProviders(null, av, ["openai"]);
    expect(r.selected.map((p) => p.name)).toEqual(["openai"]);
    expect(r.blocked).toEqual(["anthropic"]);
  });

  it("allowlist + named subset both honored", () => {
    const r = resolveProviders(["anthropic", "openai"], av, ["openai"]);
    expect(r.selected.map((p) => p.name)).toEqual(["openai"]);
    expect(r.blocked).toEqual(["anthropic"]);
  });
});

describe("pickTopOption", () => {
  it("returns [name, overall] of highest-scoring option", () => {
    const obj = { scores: [
      { option: "A", overall: 0.3 },
      { option: "B", overall: 0.7 },
      { option: "C", overall: 0.5 },
    ] };
    expect(pickTopOption(obj)).toEqual(["B", 0.7]);
  });
  it("malformed obj → [null, 0]", () => {
    expect(pickTopOption(null)).toEqual([null, 0]);
    expect(pickTopOption(42)).toEqual([null, 0]);
    expect(pickTopOption({})).toEqual([null, 0]);
    expect(pickTopOption({ scores: "bad" })).toEqual([null, 0]);
  });
  it("entries without option → skipped", () => {
    const obj = { scores: [
      { overall: 0.9 },                  // skipped
      { option: "B", overall: 0.5 },
    ] };
    expect(pickTopOption(obj)).toEqual(["B", 0.5]);
  });
});

describe("runPick — integration", () => {
  it("returns error envelope when no providers wired AND no canned set", async () => {
    const r = await runPick(
      { decision: "x", options: ["a", "b"], criteria: [{ name: "c" }] },
      { providers: {} },
    ) as { error: string };
    expect(r.error).toBe("no active providers have API keys in .env");
  });

  it("happy path: one provider, schema-valid response, ranking is 1-indexed", async () => {
    const provider = fakeProvider("p1",
      '{"scores":[{"option":"A","overall":0.8,'
      + '"by_criterion":[{"criterion":"c","score":0.8}]},'
      + '{"option":"B","overall":0.2,'
      + '"by_criterion":[{"criterion":"c","score":0.2}]}]}');
    const r = await runPick(
      { decision: "x", options: ["A", "B"], criteria: [{ name: "c" }] },
      { providers: { p1: provider } },
    ) as { ranking: { option: string; rank: number; weighted_score: number }[];
            providers_used: string[] };
    expect(r.ranking[0]!.option).toBe("A");
    expect(r.ranking[0]!.rank).toBe(1);
    expect(r.ranking[1]!.option).toBe("B");
    expect(r.ranking[1]!.rank).toBe(2);
    expect(r.providers_used).toEqual(["p1"]);
  });

  it("dissent_deltas surfaces high-stddev pairs first", async () => {
    // Two providers disagree wildly on option A's criterion c1, less so on c2.
    const p1 = fakeProvider("p1",
      '{"scores":[{"option":"A","overall":0.5,'
      + '"by_criterion":[{"criterion":"c1","score":0.9,"rationale":"hot"},'
      +                 '{"criterion":"c2","score":0.6,"rationale":"warm"}]},'
      + '{"option":"B","overall":0.5,'
      + '"by_criterion":[{"criterion":"c1","score":0.5},'
      +                 '{"criterion":"c2","score":0.5}]}]}');
    const p2 = fakeProvider("p2",
      '{"scores":[{"option":"A","overall":0.5,'
      + '"by_criterion":[{"criterion":"c1","score":0.1,"rationale":"cold"},'
      +                 '{"criterion":"c2","score":0.4,"rationale":"chill"}]},'
      + '{"option":"B","overall":0.5,'
      + '"by_criterion":[{"criterion":"c1","score":0.5},'
      +                 '{"criterion":"c2","score":0.5}]}]}');
    const r = await runPick(
      { decision: "x", options: ["A", "B"],
        criteria: [{ name: "c1" }, { name: "c2" }] },
      { providers: { p1, p2 } },
    ) as { dissent_deltas: { option: string; criterion: string; stddev: number }[] };
    // Highest-stddev should be A/c1 (0.9 vs 0.1).
    expect(r.dissent_deltas[0]!.option).toBe("A");
    expect(r.dissent_deltas[0]!.criterion).toBe("c1");
  });
});
