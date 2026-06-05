// Native-only behavior tests for runDebate.
//
// Cross-language parity is covered by test/parity/debate_tool.test.ts.

import { describe, expect, it } from "vitest";

import { runDebate, __test_internals } from "../../src/tools/debate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { DEFERRED_OPTS } = __test_internals;

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

function fakeBridge(out: unknown = { tool: "debate", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["debate"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["debate"]),
    close: async () => { /* no-op */ },
  };
}

describe("runDebate — opt deferral", () => {
  for (const opt of DEFERRED_OPTS) {
    it(`opt '${opt}'=true with bridge → defers`, async () => {
      const r = await runDebate(
        { topic: "x", [opt]: true },
        { providers: {}, bridge: fakeBridge() },
      );
      expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
    });

    it(`opt '${opt}'=true without bridge → clear error`, async () => {
      const r = await runDebate(
        { topic: "x", [opt]: true },
        { providers: {} },
      );
      expect((r as { error_code: string }).error_code).toBe("DEBATE_OPT_NOT_NATIVE");
    });
  }

  it("worker_tools=non-empty with bridge → defers", async () => {
    const r = await runDebate(
      { topic: "x", worker_tools: ["verify"] },
      { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runDebate — input gates", () => {
  it("0 providers → clear error + available_now sorted", async () => {
    const r = await runDebate(
      { topic: "x", max_rounds: 1 },
      { providers: {} },
    ) as { error: string; available_now: string[] };
    expect(r.error).toContain("at least 2 providers");
    expect(r.available_now).toEqual([]);
  });

  it("1 provider → clear error", async () => {
    const r = await runDebate(
      { topic: "x", max_rounds: 1, providers: ["a"] },
      { providers: { a: panelistFromList("a", []) } },
    ) as { error: string };
    expect(r.error).toContain("at least 2 providers");
  });

  it("unknown provider name → unknownProviderError shape", async () => {
    const r = await runDebate(
      { topic: "x", providers: ["unknown-x", "unknown-y"] },
      { providers: {} },
    ) as { unknown: string[]; unrecognised_names: string[] };
    expect(r.unknown).toEqual(["unknown-x", "unknown-y"]);
    expect(r.unrecognised_names).toEqual(["unknown-x", "unknown-y"]);
  });

  it("allowlist blocks all → 'fewer-than-2 after allowlist' error", async () => {
    const r = await runDebate(
      { topic: "x" },
      { providers: { a: panelistFromList("a", []),
                     b: panelistFromList("b", []) },
        allowlist: [] },
    ) as { error: string; blocked: string[] };
    expect(r.error).toContain("allowlist");
    expect(r.blocked).toEqual(["a", "b"]);
  });
});

describe("runDebate — round + synthesis structure", () => {
  it("2 rounds × 2 providers = 4 transcript entries with round numbers", async () => {
    const a = panelistFromList("a", ["a-r1", "a-r2", "a-synth"]);
    const b = panelistFromList("b", ["b-r1", "b-r2"]);
    const r = await runDebate(
      { topic: "x", max_rounds: 2, moderator: "a" },
      { providers: { a, b } },
    ) as {
      transcript: { provider: string; round: number; response: string }[];
      synthesis: { provider: string; response: string };
      rounds_completed: number;
    };
    expect(r.transcript).toHaveLength(4);
    expect(r.transcript[0]!).toMatchObject({ provider: "a", round: 1, response: "a-r1" });
    expect(r.transcript[1]!).toMatchObject({ provider: "b", round: 1, response: "b-r1" });
    expect(r.transcript[2]!).toMatchObject({ provider: "a", round: 2, response: "a-r2" });
    expect(r.transcript[3]!).toMatchObject({ provider: "b", round: 2, response: "b-r2" });
    expect(r.synthesis.provider).toBe("a");
    expect(r.synthesis.response).toBe("a-synth");
    expect(r.rounds_completed).toBe(2);
  });

  it("moderator outside panel → falls back to selected[0]", async () => {
    const a = panelistFromList("a", ["a-r1"]);
    const b = panelistFromList("b", ["b-r1"]);
    const r = await runDebate(
      { topic: "x", max_rounds: 1, moderator: "elsewhere" },
      { providers: { a, b } },
    ) as { synthesis: { provider: string } };
    expect(r.synthesis.provider).toBe("a");
  });

  it("prior turns embedded in round-2 messages", async () => {
    const captured: { messages: SendArgs["messages"] | null }[] = [];
    function spy(name: string, text: string): Provider {
      return {
        name, model: `${name}-default`,
        send: async (args) => {
          captured.push({ messages: args.messages });
          return { text, attempts: 1,
                   usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
        },
      };
    }
    const a = spy("a", "answer-a");
    const b = spy("b", "answer-b");
    await runDebate(
      { topic: "T", max_rounds: 2, moderator: "a" },
      { providers: { a, b } },
    );
    // Round-2 messages (call indices 2 and 3) should contain "PRIOR TURNS:".
    const r2a = (captured[2]!.messages as readonly { content: string }[])
      .map((m) => m.content).join("\n");
    expect(r2a).toContain("PRIOR TURNS:");
    expect(r2a).toContain("[a — round 1]");
    expect(r2a).toContain("[b — round 1]");
  });

  it("default max_rounds=3 when arg omitted", async () => {
    const a = panelistFromList("a", ["a-r1", "a-r2", "a-r3", "a-synth"]);
    const b = panelistFromList("b", ["b-r1", "b-r2", "b-r3"]);
    const r = await runDebate(
      { topic: "x", moderator: "a" },
      { providers: { a, b } },
    ) as { rounds_completed: number };
    expect(r.rounds_completed).toBe(3);
  });
});
