// Native-only behavior tests for runReview.
//
// Cross-language parity covered by test/parity/review_tool.test.ts.

import { describe, expect, it } from "vitest";

import { runReview } from "../../src/tools/review.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

function spy(name: string, text: string): {
  provider: Provider;
  captured: { messages: SendArgs["messages"] | null };
} {
  const captured: { messages: SendArgs["messages"] | null } = { messages: null };
  return {
    provider: {
      name, model: `${name}-default`,
      send: async (args: SendArgs): Promise<SendResult> => {
        captured.messages = args.messages;
        return { text, attempts: 1,
                 usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
      },
    },
    captured,
  };
}

describe("runReview — prompt construction", () => {
  it("question = INTENT + SNIPPET wrapped in markdown fence", async () => {
    const { provider, captured } = spy("a", "looks good");
    await runReview(
      { snippet: "function f() {}",
        intent: "Returns void." },
      { providers: { a: provider } },
    );
    const userMsg = captured.messages!.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("Review the following code/proposal as peers.");
    expect(userMsg).toContain("INTENT: Returns void.");
    expect(userMsg).toContain("SNIPPET:\n```\nfunction f() {}\n```");
  });

  it("missing intent → '(not stated)'", async () => {
    const { provider, captured } = spy("a", "ok");
    await runReview(
      { snippet: "x" },
      { providers: { a: provider } },
    );
    const userMsg = captured.messages!.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("INTENT: (not stated)");
  });

  it("output IS a confer envelope (tool: 'confer'), not 'review'", async () => {
    const { provider } = spy("a", "ok");
    const r = await runReview(
      { snippet: "x" },
      { providers: { a: provider } },
    ) as { tool: string; answers: unknown[] };
    expect(r.tool).toBe("confer");
    expect(r.answers).toHaveLength(1);
  });

  it("untrusted_input passes through to confer (defers to bridge if set)", async () => {
    const bridge = {
      toolNames: new Set(["confer"]),
      pid: 99999,
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ tool: "confer", from_bridge: true }) }],
      }),
      refreshTools: async () => new Set(["confer"]),
      close: async () => { /* no-op */ },
    };
    const r = await runReview(
      { snippet: "x", untrusted_input: true },
      { providers: {}, bridge },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});
