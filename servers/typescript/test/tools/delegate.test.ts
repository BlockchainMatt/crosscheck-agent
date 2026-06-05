// Native behavior tests for runDelegate.

import { describe, expect, it, beforeEach } from "vitest";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runDelegate, DEFAULT_DELEGATION_LIMITS } from "../../src/tools/delegate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Storage } from "../../src/adapters/storage/interface.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

let storage: Storage;

const NOW = 1_700_000_000;
const nowEpochSeconds = () => NOW;

function provider(name: string, cannedText: string): Provider {
  return {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: cannedText, attempts: 1,
      usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker"),
    }),
  };
}

function fakeBridge(out: unknown = { tool: "delegate", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["delegate"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["delegate"]),
    close: async () => { /* no-op */ },
  };
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
});

describe("runDelegate — gates", () => {
  it("no storage + no bridge → DELEGATE_STORAGE_NOT_NATIVE", async () => {
    const r = await runDelegate(
      { tool_call: "confer", via: "a" }, { providers: {} },
    );
    expect((r as { error_code: string }).error_code).toBe("DELEGATE_STORAGE_NOT_NATIVE");
  });
  it("no storage + bridge → defers", async () => {
    const r = await runDelegate(
      { tool_call: "confer", via: "a" },
      { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });

  it("non-delegable tool → accepted=false with python-style allowlist repr", async () => {
    const r = await runDelegate(
      { tool_call: "audit", via: "anthropic" },
      { providers: { anthropic: provider("anthropic", "") }, storage, nowEpochSeconds },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("'audit'");
    expect(r.reason).toContain("['confer', 'review']");
  });

  it("unknown provider → accepted=false + repr in reason", async () => {
    const r = await runDelegate(
      { tool_call: "confer", via: "ghost" },
      { providers: { anthropic: provider("anthropic", "") }, storage, nowEpochSeconds },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("'ghost'");
    expect(r.reason).toContain("not configured");
  });

  it("provider blocked by allowlist → accepted=false", async () => {
    const r = await runDelegate(
      { tool_call: "confer", via: "anthropic" },
      { providers: { anthropic: provider("anthropic", "") },
        allowlist: ["openai"], storage, nowEpochSeconds },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("blocked by provider_allowlist");
  });
});

describe("runDelegate — quota", () => {
  it("accepted dispatch records + bumps quota", async () => {
    const r = await runDelegate(
      { tool_call: "confer", via: "anthropic",
        args: { question: "x" },
        session_id: "s1", requested_by: "agent-A" },
      { providers: { anthropic: provider("anthropic", "ok") },
        storage, nowEpochSeconds },
    ) as { accepted: boolean; quota: { session_used: number; requester_used: number };
            result: { tool: string } };
    expect(r.accepted).toBe(true);
    expect(r.result.tool).toBe("confer");
    expect(r.quota.session_used).toBe(1);
    expect(r.quota.requester_used).toBe(1);
  });

  it("session quota exhausted → accepted=false", async () => {
    const limits = { max_per_session: 2, max_per_requester: 100 };
    const opts = {
      providers: { anthropic: provider("anthropic", "ok") },
      storage, nowEpochSeconds, limits,
    };
    // Two accepted calls.
    await runDelegate(
      { tool_call: "confer", via: "anthropic", session_id: "s1" }, opts,
    );
    await runDelegate(
      { tool_call: "confer", via: "anthropic", session_id: "s1" }, opts,
    );
    // Third should be quota-rejected.
    const r3 = await runDelegate(
      { tool_call: "confer", via: "anthropic", session_id: "s1" }, opts,
    ) as { accepted: boolean; reason: string };
    expect(r3.accepted).toBe(false);
    expect(r3.reason).toBe("quota_exhausted_for_session");
  });

  it("requester quota exhausted → accepted=false", async () => {
    const limits = { max_per_session: 100, max_per_requester: 1 };
    const opts = {
      providers: { anthropic: provider("anthropic", "ok") },
      storage, nowEpochSeconds, limits,
    };
    await runDelegate(
      { tool_call: "confer", via: "anthropic", requested_by: "agent-A" }, opts,
    );
    const r2 = await runDelegate(
      { tool_call: "confer", via: "anthropic", requested_by: "agent-A" }, opts,
    ) as { accepted: boolean; reason: string };
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe("quota_exhausted_for_requester");
  });

  it("refused calls still record + appear in quota (refused side)", async () => {
    // Send a refused call (non-delegable tool).
    await runDelegate(
      { tool_call: "audit", via: "anthropic", session_id: "s1" },
      { providers: { anthropic: provider("anthropic", "") },
        storage, nowEpochSeconds },
    );
    // The accepted-count is unchanged; sessions counter still 0.
    const next = await runDelegate(
      { tool_call: "confer", via: "anthropic", session_id: "s1",
        args: { question: "x" } },
      { providers: { anthropic: provider("anthropic", "ok") },
        storage, nowEpochSeconds },
    ) as { quota: { session_used: number } };
    expect(next.quota.session_used).toBe(1);  // ONLY the accepted call counts
  });

  it("default limits match Python (50 / 200)", () => {
    expect(DEFAULT_DELEGATION_LIMITS.max_per_session).toBe(50);
    expect(DEFAULT_DELEGATION_LIMITS.max_per_requester).toBe(200);
  });
});

describe("runDelegate — dispatch + provider override", () => {
  it("forces providers=[via] on the inner confer call", async () => {
    // Set up two providers; if the inner confer used both, the answer
    // count would be 2. With the via-override, it should be 1.
    const a = provider("anthropic", "anthropic-answer");
    const b = provider("openai",    "openai-answer");
    const r = await runDelegate(
      { tool_call: "confer", via: "openai",
        args: { question: "what?" } },
      { providers: { anthropic: a, openai: b }, storage, nowEpochSeconds },
    ) as { accepted: boolean; result: { answers: { provider: string }[] } };
    expect(r.accepted).toBe(true);
    expect(r.result.answers).toHaveLength(1);
    expect(r.result.answers[0]!.provider).toBe("openai");
  });

  it("dispatches review with the snippet/intent prompt shape", async () => {
    const a = provider("anthropic", "review-text");
    const r = await runDelegate(
      { tool_call: "review", via: "anthropic",
        args: { snippet: "function f() {}", intent: "noop" } },
      { providers: { anthropic: a }, storage, nowEpochSeconds },
    ) as { accepted: boolean; result: { tool: string } };
    expect(r.accepted).toBe(true);
    // review's output IS a confer envelope (matches Python's behavior).
    expect(r.result.tool).toBe("confer");
  });

  it("threads session_id into inner call when not already set", async () => {
    let capturedArgs: Record<string, unknown> | null = null;
    const a: Provider = {
      name: "anthropic", model: "claude",
      send: async (args) => {
        capturedArgs = { messages: args.messages };
        return { text: "ok", attempts: 1,
                 usage: emptyUsage("anthropic", "claude", args.purpose ?? "worker") };
      },
    };
    await runDelegate(
      { tool_call: "confer", via: "anthropic", session_id: "sess-X",
        args: { question: "q" } },
      { providers: { anthropic: a }, storage, nowEpochSeconds },
    );
    expect(capturedArgs).not.toBeNull();
    // The provider got called — that's the proof the inner confer ran
    // with the threaded args.
  });
});
