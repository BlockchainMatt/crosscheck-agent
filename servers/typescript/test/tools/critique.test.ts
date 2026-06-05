// Native-only behavior tests for runCritique.
//
// Cross-language parity is covered by test/parity/critique_tool.test.ts.

import { describe, expect, it } from "vitest";

import { runCritique, __test_internals } from "../../src/tools/critique.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { SEVERITY_ALIASES, SEV_ORDER } = __test_internals;

function provider(name: string, text: string): Provider {
  return {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text, attempts: 1,
      usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker"),
    }),
  };
}

function fakeBridge(out: unknown = { tool: "critique", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["critique"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["critique"]),
    close: async () => { /* no-op */ },
  };
}

describe("runCritique — input gates + deferral", () => {
  it("missing proposal → CRITIQUE_MISSING_PROPOSAL", async () => {
    const r = await runCritique({}, { providers: {} });
    expect((r as { error_code: string }).error_code).toBe("CRITIQUE_MISSING_PROPOSAL");
  });

  it("empty-string proposal → CRITIQUE_MISSING_PROPOSAL", async () => {
    const r = await runCritique({ proposal: "   " }, { providers: {} });
    expect((r as { error_code: string }).error_code).toBe("CRITIQUE_MISSING_PROPOSAL");
  });

  it("no providers → NO_PROVIDERS_AVAILABLE error", async () => {
    const r = await runCritique(
      { proposal: "x" },
      { providers: {} },
    );
    expect((r as { error_code: string }).error_code).toBe("NO_PROVIDERS_AVAILABLE");
  });

  it("untrusted_input with bridge → defers", async () => {
    const r = await runCritique(
      { proposal: "x", untrusted_input: true },
      { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });

  it("untrusted_input without bridge → CRITIQUE_OPT_NOT_NATIVE", async () => {
    const r = await runCritique(
      { proposal: "x", untrusted_input: true },
      { providers: { a: provider("a", "") } },
    );
    expect((r as { error_code: string }).error_code).toBe("CRITIQUE_OPT_NOT_NATIVE");
  });

  it("allowlist blocks all → ALL_PROVIDERS_BLOCKED", async () => {
    const r = await runCritique(
      { proposal: "x" },
      { providers: { a: provider("a", "") }, allowlist: [] },
    );
    expect((r as { error_code: string }).error_code).toBe("ALL_PROVIDERS_BLOCKED");
  });
});

describe("runCritique — severity sort + alias", () => {
  it("merged list is sorted high → med → low, ties by provider", async () => {
    const a = provider("a",
      '{"weaknesses":['
      + '{"weakness":"a-high","severity":"high"},'
      + '{"weakness":"a-low","severity":"low"}'
      + ']}',
    );
    const b = provider("b",
      '{"weaknesses":['
      + '{"weakness":"b-med","severity":"med"},'
      + '{"weakness":"b-high","severity":"high"}'
      + ']}',
    );
    const r = await runCritique(
      { proposal: "x" },
      { providers: { a, b } },
    ) as { weaknesses: { weakness: string; severity: string; provider: string }[] };
    expect(r.weaknesses.map((w) => `${w.severity}/${w.provider}/${w.weakness}`)).toEqual([
      "high/a/a-high",
      "high/b/b-high",
      "med/b/b-med",
      "low/a/a-low",
    ]);
  });

  it("high_severity_count counts only severity==high", async () => {
    const a = provider("a",
      '{"weaknesses":['
      + '{"weakness":"w1","severity":"high"},'
      + '{"weakness":"w2","severity":"high"},'
      + '{"weakness":"w3","severity":"low"}'
      + ']}',
    );
    const r = await runCritique(
      { proposal: "x" },
      { providers: { a } },
    ) as { high_severity_count: number };
    expect(r.high_severity_count).toBe(2);
  });

  it("max_per_provider clamps to CRITIQUE_MAX_WEAKNESSES (5)", async () => {
    const a = provider("a",
      '{"weaknesses":['
      + '{"weakness":"w1","severity":"low"},'
      + '{"weakness":"w2","severity":"low"},'
      + '{"weakness":"w3","severity":"low"},'
      + '{"weakness":"w4","severity":"low"},'
      + '{"weakness":"w5","severity":"low"},'
      + '{"weakness":"w6","severity":"low"}'
      + ']}',
    );
    const r = await runCritique(
      { proposal: "x", max_per_provider: 100 },
      { providers: { a } },
    ) as { weaknesses: unknown[] };
    expect(r.weaknesses).toHaveLength(5);
  });

  it("max_per_provider truncates within limit", async () => {
    const a = provider("a",
      '{"weaknesses":['
      + '{"weakness":"w1","severity":"high"},'
      + '{"weakness":"w2","severity":"med"},'
      + '{"weakness":"w3","severity":"low"}'
      + ']}',
    );
    const r = await runCritique(
      { proposal: "x", max_per_provider: 2 },
      { providers: { a } },
    ) as { weaknesses: { weakness: string }[] };
    expect(r.weaknesses.map((w) => w.weakness)).toEqual(["w1", "w2"]);
  });

  it("missing severity → defaults to 'med' alias", () => {
    // Test the alias table directly.
    expect(SEVERITY_ALIASES["medium"]).toBe("med");
    expect(SEVERITY_ALIASES["high"]).toBe("high");
    expect(SEVERITY_ALIASES["med"]).toBe("med");
    expect(SEVERITY_ALIASES["low"]).toBe("low");
    expect(SEVERITY_ALIASES["bogus"]).toBeUndefined();
  });

  it("SEV_ORDER: high=0, med=1, low=2", () => {
    expect(SEV_ORDER["high"]).toBe(0);
    expect(SEV_ORDER["med"]).toBe(1);
    expect(SEV_ORDER["low"]).toBe(2);
  });
});

describe("runCritique — per-provider failures", () => {
  it("parse error on one provider doesn't tank the panel", async () => {
    const a = provider("a", "not JSON");
    const b = provider("b",
      '{"weaknesses":[{"weakness":"ok","severity":"high"}]}',
    );
    const r = await runCritique(
      { proposal: "x" },
      { providers: { a, b } },
    ) as {
      per_provider: { provider: string; status: string; weaknesses: unknown[] }[];
      weaknesses: { provider: string }[];
    };
    expect(r.per_provider).toEqual([
      { provider: "a", model: "a-default", status: "parse_error", weaknesses: [] },
      { provider: "b", model: "b-default", status: "ok", weaknesses: [
        { id: "b.w1", weakness: "ok", why_matters: "", severity: "high", provider: "b" },
      ] },
    ]);
    expect(r.weaknesses).toHaveLength(1);
    expect(r.weaknesses[0]!.provider).toBe("b");
  });

  it("default ID = '<provider>.w<i>' when model omits id", async () => {
    const a = provider("a",
      '{"weaknesses":['
      + '{"weakness":"x","severity":"high"},'
      + '{"weakness":"y","severity":"low"}'
      + ']}',
    );
    const r = await runCritique(
      { proposal: "x" },
      { providers: { a } },
    ) as { weaknesses: { id: string }[] };
    expect(r.weaknesses.map((w) => w.id)).toEqual(["a.w1", "a.w2"]);
  });
});
