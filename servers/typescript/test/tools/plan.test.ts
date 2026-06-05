// Native-only behavior tests for runPlan.
//
// Cross-language parity is covered by test/parity/plan_tool.test.ts.
// These tests focus on plan-specific behavior — prompt construction
// and arg pass-through to debate.

import { describe, expect, it } from "vitest";

import { runPlan } from "../../src/tools/plan.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

function spy(name: string, texts: string[]): {
  provider: Provider;
  seenSystemForRoundOne: string | null;
} {
  let i = 0;
  const box = { seenSystemForRoundOne: null as string | null };
  const p: Provider = {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => {
      // Capture the first call's user message (round 1) — that's where
      // the topic block lands and where we can verify the GOAL prompt.
      if (i === 0) {
        const userMsg = args.messages.find((m) => m.role === "user");
        if (userMsg) box.seenSystemForRoundOne = String(userMsg.content);
      }
      const text = i < texts.length ? texts[i]! : "";
      i++;
      return { text, attempts: 1,
               usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
    },
  };
  return { provider: p, seenSystemForRoundOne: box.seenSystemForRoundOne,
           get [Symbol.toPrimitive]() { return () => box.seenSystemForRoundOne; },
           ...box } as never;
}

describe("runPlan — prompt construction", () => {
  it("topic = GOAL + CONSTRAINTS prompt; constraints renders explicit value", async () => {
    const captured: { messages: SendArgs["messages"][] } = { messages: [] };
    const provider: Provider = {
      name: "a", model: "a-default",
      send: async (args) => {
        captured.messages.push(args.messages);
        return { text: "ok", attempts: 1,
                 usage: emptyUsage("a", "a-default", args.purpose ?? "worker") };
      },
    };
    const b: Provider = {
      name: "b", model: "b-default",
      send: async (args) => ({
        text: "ok", attempts: 1,
        usage: emptyUsage("b", "b-default", args.purpose ?? "worker"),
      }),
    };
    await runPlan(
      { goal: "Migrate to gRPC.", constraints: "Zero downtime.",
        max_rounds: 1, moderator: "a" },
      { providers: { a: provider, b } },
    );
    // Round-1 messages — TOPIC: ... contains the merged prompt.
    const r1Topic = captured.messages[0]!.find(
      (m) => m.role === "user" && m.content.startsWith("TOPIC:"),
    )!.content;
    expect(r1Topic).toContain("We need a step-by-step plan to achieve this goal.");
    expect(r1Topic).toContain("GOAL: Migrate to gRPC.");
    expect(r1Topic).toContain("CONSTRAINTS: Zero downtime.");
    expect(r1Topic).toContain("Return: (1) the plan as numbered steps");
  });

  it("missing constraints → '(none stated)'", async () => {
    const captured: { messages: SendArgs["messages"][] } = { messages: [] };
    const provider: Provider = {
      name: "a", model: "a-default",
      send: async (args) => {
        captured.messages.push(args.messages);
        return { text: "ok", attempts: 1,
                 usage: emptyUsage("a", "a-default", args.purpose ?? "worker") };
      },
    };
    const b: Provider = {
      name: "b", model: "b-default",
      send: async (args) => ({
        text: "ok", attempts: 1,
        usage: emptyUsage("b", "b-default", args.purpose ?? "worker"),
      }),
    };
    await runPlan(
      { goal: "Reduce p99.", max_rounds: 1, moderator: "a" },
      { providers: { a: provider, b } },
    );
    const r1Topic = captured.messages[0]!.find(
      (m) => m.role === "user" && m.content.startsWith("TOPIC:"),
    )!.content;
    expect(r1Topic).toContain("CONSTRAINTS: (none stated)");
  });

  it("structured=true defers to bridge (via debate's deferral)", async () => {
    const bridge = {
      toolNames: new Set(["debate"]),
      pid: 99999,
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ tool: "debate", from_bridge: true }) }],
      }),
      refreshTools: async () => new Set(["debate"]),
      close: async () => { /* no-op */ },
    };
    const a: Provider = {
      name: "a", model: "a-default",
      send: async (args) => ({
        text: "ok", attempts: 1,
        usage: emptyUsage("a", "a-default", args.purpose ?? "worker"),
      }),
    };
    const r = await runPlan(
      { goal: "x", structured: true },
      { providers: { a }, bridge },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});
