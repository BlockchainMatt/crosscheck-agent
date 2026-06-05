// Native-only behavior tests for runConfer.
//
// Cross-language parity is covered by test/parity/confer_tool.test.ts.
// This file covers the v1-only behavior: opt-deferral to bridge,
// provider resolution edge cases, message construction.

import { describe, expect, it } from "vitest";

import { runConfer, __test_internals } from "../../src/tools/confer.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { DEFERRED_OPTS, resolveProviders } = __test_internals;

function fakeProvider(name: string, cannedText: string): { provider: Provider; lastMessages: SendArgs["messages"] | null } {
  const box: { lastMessages: SendArgs["messages"] | null } = { lastMessages: null };
  const provider: Provider = {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => {
      box.lastMessages = args.messages;
      return {
        text: cannedText, attempts: 1,
        usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker"),
      };
    },
  };
  return { provider, lastMessages: null,
           get [Symbol.toPrimitive]() { return () => box.lastMessages; } } as never;
}

function fakeBridge(out: unknown = { tool: "confer", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["confer"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["confer"]),
    close: async () => { /* no-op */ },
  };
}

function plainFake(name: string, text: string): {
  provider: Provider;
  captured: { messages: SendArgs["messages"] | null };
} {
  const captured: { messages: SendArgs["messages"] | null } = { messages: null };
  const provider: Provider = {
    name, model: `${name}-default`,
    send: async (args) => {
      captured.messages = args.messages;
      return { text, attempts: 1,
               usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
    },
  };
  return { provider, captured };
}

describe("runConfer — opt deferral", () => {
  for (const opt of DEFERRED_OPTS) {
    it(`opt '${opt}'=true with bridge → defers`, async () => {
      const r = await runConfer(
        { question: "x", [opt]: true },
        { providers: {}, bridge: fakeBridge() },
      );
      expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
    });

    it(`opt '${opt}'=true without bridge → clear error`, async () => {
      const r = await runConfer(
        { question: "x", [opt]: true },
        { providers: { a: plainFake("a", "").provider } },
      );
      expect((r as { error_code: string }).error_code).toBe("CONFER_OPT_NOT_NATIVE");
    });
  }

  it("worker_tools=non-empty with bridge → defers", async () => {
    const r = await runConfer(
      { question: "x", worker_tools: ["verify"] },
      { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });

  it("worker_tools=[] (empty) → does NOT defer (treated as plain call)", async () => {
    const { provider } = plainFake("a", "answer");
    const r = await runConfer(
      { question: "x", worker_tools: [] },
      { providers: { a: provider } },
    ) as { answers: { provider: string }[] };
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]!.provider).toBe("a");
  });
});

describe("runConfer — provider resolution edge cases", () => {
  it("no providers, no allowlist → 'no active providers' error", async () => {
    const r = await runConfer({ question: "x" }, { providers: {} });
    expect((r as { error: string }).error).toBe("no active providers have API keys in .env");
  });

  it("unknown provider name → unknownProviderError shape", async () => {
    const r = await runConfer(
      { question: "x", providers: ["typo-name"] },
      { providers: {} },
    ) as { unknown: string[]; unrecognised_names: string[] };
    expect(r.unknown).toEqual(["typo-name"]);
    expect(r.unrecognised_names).toEqual(["typo-name"]);
  });

  it("allowlist blocks all → 'all blocked' error", async () => {
    const { provider } = plainFake("a", "hi");
    const r = await runConfer(
      { question: "x" },
      { providers: { a: provider }, allowlist: ["b"] },
    ) as { error: string; blocked: string[] };
    expect(r.error).toContain("blocked");
    expect(r.blocked).toEqual(["a"]);
  });
});

describe("runConfer — message construction", () => {
  it("builds [system, user(question)] when no context", async () => {
    const { provider, captured } = plainFake("a", "x");
    await runConfer(
      { question: "What's up?" },
      { providers: { a: provider } },
    );
    expect(captured.messages).toHaveLength(2);
    expect(captured.messages![0]!.role).toBe("system");
    expect(captured.messages![1]!.role).toBe("user");
    expect(captured.messages![1]!.content).toBe("What's up?");
  });

  it("builds [system, user(CONTEXT:), user(question)] when context provided", async () => {
    const { provider, captured } = plainFake("a", "x");
    await runConfer(
      { question: "Q?", context: "background facts" },
      { providers: { a: provider } },
    );
    expect(captured.messages).toHaveLength(3);
    expect(captured.messages![1]!.content).toBe("CONTEXT:\nbackground facts");
    expect(captured.messages![2]!.content).toBe("Q?");
  });

  it("system message matches Python byte-for-byte", async () => {
    const { provider, captured } = plainFake("a", "x");
    await runConfer({ question: "Q" }, { providers: { a: provider } });
    expect(captured.messages![0]!.content).toBe(
      "You are part of a panel of LLMs consulted by an engineer working " +
      "inside Claude Code. Answer directly, cite assumptions, and keep it crisp.",
    );
  });
});

describe("resolveProviders", () => {
  it("null names → all available", () => {
    const av = { a: plainFake("a", "").provider, b: plainFake("b", "").provider };
    const r = resolveProviders(null, av, null);
    expect(r.selected.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("named subset, dedupe, normalize case", () => {
    const av = { a: plainFake("a", "").provider, b: plainFake("b", "").provider };
    const r = resolveProviders(["A", "b", "  A  "], av, null);
    expect(r.selected.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("unknown name surfaced in unknown[]", () => {
    const av = { a: plainFake("a", "").provider };
    const r = resolveProviders(["a", "zzz"], av, null);
    expect(r.unknown).toEqual(["zzz"]);
  });
});
