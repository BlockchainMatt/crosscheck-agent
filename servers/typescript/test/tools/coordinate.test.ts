// Native-only behavior tests for runCoordinate.

import { describe, expect, it } from "vitest";

import { runCoordinate, __test_internals } from "../../src/tools/coordinate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { DEFERRED_OPTS, formatRoleTurn } = __test_internals;

function panelistFromList(name: string, texts: string[]): Provider {
  let i = 0;
  return {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => {
      const text = i < texts.length ? texts[i]! : "";
      i++;
      return { text, attempts: 1,
               usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
    },
  };
}

function fakeBridge(out: unknown = { tool: "coordinate", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["coordinate"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["coordinate"]),
    close: async () => { /* no-op */ },
  };
}

describe("runCoordinate — opt deferral", () => {
  for (const opt of DEFERRED_OPTS) {
    it(`opt '${opt}'=true with bridge → defers`, async () => {
      const r = await runCoordinate(
        { topic: "x", [opt]: true },
        { providers: {}, bridge: fakeBridge() },
      );
      expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
    });
    it(`opt '${opt}'=true without bridge → clear error`, async () => {
      const r = await runCoordinate(
        { topic: "x", [opt]: true },
        { providers: {} },
      );
      expect((r as { error_code: string }).error_code).toBe("COORDINATE_OPT_NOT_NATIVE");
    });
  }

  it("worker_tools=non-empty with bridge → defers", async () => {
    const r = await runCoordinate(
      { topic: "x", worker_tools: ["verify"] },
      { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runCoordinate — input gates", () => {
  it("0 providers → clear error", async () => {
    const r = await runCoordinate(
      { topic: "x" },
      { providers: {} },
    ) as { error: string };
    expect(r.error).toContain("at least 2 providers");
  });

  it("1 provider → clear error", async () => {
    const r = await runCoordinate(
      { topic: "x", providers: ["a"] },
      { providers: { a: panelistFromList("a", []) } },
    ) as { error: string };
    expect(r.error).toContain("at least 2 providers");
  });

  it("unknown provider names with too few resolved → unknownProviderError", async () => {
    const r = await runCoordinate(
      { topic: "x", providers: ["unknown-x", "unknown-y"] },
      { providers: {} },
    ) as { unknown: string[] };
    expect(r.unknown).toEqual(["unknown-x", "unknown-y"]);
  });
});

describe("runCoordinate — role assignment", () => {
  // Default role assignment with 3 providers — moderator config defaults
  // to "anthropic" if not set, so synth = anthropic when present.
  it("3 providers, no role args, default moderator='anthropic' → synth=anthropic", async () => {
    const a = panelistFromList("anthropic", [
      '{"role":"proposer","summary":"go","confidence":0.9,"ballot":"agree"}',
      '{"consensus":"go","weighted_confidence":0.8,"key_claims":[{"claim":"x","confidence":0.5}]}',
    ]);
    const o = panelistFromList("openai", [
      '{"role":"critic","summary":"slow","confidence":0.5,"ballot":"disagree"}',
    ]);
    const x = panelistFromList("xai", [
      '{"role":"critic","summary":"meh","confidence":0.5,"ballot":"abstain"}',
    ]);
    const r = await runCoordinate(
      { topic: "T" },
      { providers: { anthropic: a, openai: o, xai: x } },
    ) as { roles: { proposer: string; critics: string[]; synthesizer: string } };
    expect(r.roles).toEqual({
      proposer:    "anthropic",
      critics:     ["openai", "xai"],
      synthesizer: "anthropic",
    });
  });

  it("explicit proposer + synth + critics override defaults", async () => {
    const a = panelistFromList("a", [
      '{"role":"proposer","summary":"a","confidence":0.7,"ballot":"agree"}',
      '{"consensus":"ok","weighted_confidence":0.6,"key_claims":[]}',
    ]);
    const b = panelistFromList("b", [
      '{"role":"critic","summary":"b","confidence":0.6,"ballot":"agree"}',
    ]);
    const c = panelistFromList("c", []);
    const r = await runCoordinate(
      { topic: "T", proposer: "a", synthesizer: "a", critics: ["b"] },
      { providers: { a, b, c } },
    ) as { roles: { proposer: string; critics: string[]; synthesizer: string } };
    expect(r.roles).toEqual({
      proposer:    "a",
      critics:     ["b"],
      synthesizer: "a",
    });
  });

  it("synth name not in providers → falls back to proposer", async () => {
    const a = panelistFromList("a", [
      '{"role":"proposer","summary":"a","confidence":0.7,"ballot":"agree"}',
      '{"consensus":"ok","weighted_confidence":0.6,"key_claims":[]}',
    ]);
    const b = panelistFromList("b", [
      '{"role":"critic","summary":"b","confidence":0.6,"ballot":"agree"}',
    ]);
    const r = await runCoordinate(
      { topic: "T", synthesizer: "nowhere" },
      { providers: { a, b } },
    ) as { roles: { synthesizer: string } };
    expect(r.roles.synthesizer).toBe("a");
  });

  it("0 critics after exclusions → error envelope", async () => {
    const a = panelistFromList("a", [""]);
    const b = panelistFromList("b", [""]);
    const r = await runCoordinate(
      // explicit critics=[] forces empty; but in Python the empty-list
      // path checks ALL_PROVIDERS, so critic_names = []. With our
      // 2-provider panel and synth defaulting to "anthropic" which
      // isn't present, synth falls back to proposer (a). Then critics
      // computed as selected - proposer - synth = [b], so the explicit
      // empty-list bypass is the only way to hit this.
      { topic: "T", critics: [] },
      { providers: { a, b } },
    ) as { error?: string };
    expect(r.error).toContain("could not assign at least one critic");
  });
});

describe("formatRoleTurn (helper)", () => {
  it("renders proposer with claims + citations", () => {
    const out = formatRoleTurn("proposer", {
      summary: "use rust",
      confidence: 0.9,
      ballot: "agree",
      claims: [{ claim: "rust is fast", confidence: 0.85 }],
      citations: ["rfc-3"],
    }, "");
    expect(out).toContain("[proposer] summary: use rust");
    expect(out).toContain("  confidence: 0.9");
    expect(out).toContain("  ballot: agree");
    expect(out).toContain("  - claim: rust is fast (conf=0.85)");
    expect(out).toContain("  cite: rfc-3");
  });

  it("null obj → fallback text", () => {
    expect(formatRoleTurn("critic[x]", null, "raw text")).toBe("raw text");
  });

  it("null obj + no fallback → marker", () => {
    expect(formatRoleTurn("critic[x]", null, "")).toBe("(critic[x]: no structured output)");
  });
});
