// Native-only behavior tests for runAudit + pickAuditor.
//
// Cross-language parity is covered by test/parity/audit_tool.test.ts.
// This file covers v1 native behavior: deferral to bridge, auditor
// selection ordering, error paths, default rubric ergonomics.

import { describe, expect, it } from "vitest";

import { runAudit, __test_internals, DEFAULT_AUDIT_RUBRICS } from "../../src/tools/audit.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { pickAuditor } = __test_internals;

function fakeProvider(name: string, cannedText: string, model?: string): Provider {
  const m = model ?? `${name}-default`;
  return {
    name, model: m,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: cannedText, attempts: 1,
      usage: emptyUsage(name, m, args.purpose ?? "worker"),
    }),
  };
}

function fakeBridge(opts: { hasAudit?: boolean; out?: unknown } = {}): BridgeHandle {
  return {
    toolNames: new Set(opts.hasAudit === false ? [] : ["audit"]),
    pid: 99999,
    callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify(opts.out ?? {}) }],
    }),
    refreshTools: async () => new Set(["audit"]),
    close: async () => { /* no-op */ },
  };
}

describe("pickAuditor", () => {
  const providers = {
    anthropic: fakeProvider("anthropic", ""),
    openai:    fakeProvider("openai", ""),
    xai:       fakeProvider("xai", ""),
  };

  it("explicit auditor wins when not in exclude + not blocked", () => {
    const r = pickAuditor(providers, new Set(), "openai", "anthropic", null);
    expect(r.auditor?.name).toBe("openai");
  });

  it("explicit auditor in exclude → reason fired", () => {
    const r = pickAuditor(providers, new Set(["openai"]), "openai", "anthropic", null);
    expect(r.auditor).toBeNull();
    expect(r.reason).toContain("producing panel");
  });

  it("unknown explicit name → reason fired", () => {
    const r = pickAuditor(providers, new Set(), "doesnt-exist", "anthropic", null);
    expect(r.auditor).toBeNull();
    expect(r.reason).toContain("not configured");
  });

  it("falls through to moderator when no explicit", () => {
    const r = pickAuditor(providers, new Set(), null, "anthropic", null);
    expect(r.auditor?.name).toBe("anthropic");
  });

  it("moderator excluded → first non-excluded", () => {
    const r = pickAuditor(providers, new Set(["anthropic"]), null, "anthropic", null);
    expect(r.auditor?.name).toBe("openai");
  });

  it("all excluded → null + helpful reason", () => {
    const r = pickAuditor(
      providers, new Set(["anthropic", "openai", "xai"]),
      null, "anthropic", null,
    );
    expect(r.auditor).toBeNull();
    expect(r.reason).toContain("widen the panel");
  });

  it("allowlist filters non-listed providers out of the moderator fallback", () => {
    const r = pickAuditor(
      { anthropic: providers.anthropic, openai: providers.openai },
      new Set(), null, "anthropic", ["openai"],
    );
    expect(r.auditor?.name).toBe("openai");
  });
});

describe("runAudit — input gates + deferral", () => {
  it("missing output_to_audit AND no session → error envelope", async () => {
    const r = await runAudit({}, { providers: { anthropic: fakeProvider("anthropic", "") } });
    expect((r as { error_code: string }).error_code).toBe("AUDIT_MISSING_INPUT");
  });

  it("session-id-only without bridge → clear error", async () => {
    const r = await runAudit({ session_id: "abc" },
      { providers: { anthropic: fakeProvider("anthropic", "") } });
    expect((r as { error_code: string }).error_code).toBe("AUDIT_SESSION_LOAD_NOT_NATIVE");
  });

  it("session-id-only WITH bridge → defers", async () => {
    let called = false;
    const bridge = fakeBridge({
      out: { tool: "audit", from_bridge: true },
    });
    const origCallTool = bridge.callTool;
    (bridge as { callTool: typeof origCallTool }).callTool = async (...a) => {
      called = true; return origCallTool(...a);
    };
    const r = await runAudit({ session_id: "abc" },
      { providers: {}, bridge });
    expect(called).toBe(true);
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });

  it("coalesce without bridge → clear error", async () => {
    const r = await runAudit(
      { output_to_audit: "x", coalesce: true },
      { providers: { anthropic: fakeProvider("anthropic", "") } },
    );
    expect((r as { error_code: string }).error_code).toBe("AUDIT_COALESCE_NOT_NATIVE");
  });

  it("coalesce WITH bridge → defers", async () => {
    const bridge = fakeBridge({
      out: { tool: "audit", mode: "coalesced", from_bridge: true },
    });
    const r = await runAudit(
      { output_to_audit: "x", coalesce: true },
      { providers: {}, bridge },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });

  it("no auditor available → clear error", async () => {
    const r = await runAudit(
      { output_to_audit: "x" },
      { providers: {} },                       // no providers
    );
    expect((r as { error_code: string }).error_code).toBe("AUDIT_NO_AUDITOR");
  });
});

describe("runAudit — happy path + envelope", () => {
  it("default rubric: all 6 items emitted in order, even when model returns a subset", async () => {
    // Model returns only 1 item — the other 5 default to score=0, pass=false.
    const auditor = fakeProvider("anthropic",
      '{"items":[{"id":"factual_grounding","score":0.95,"pass":true,"rationale":"good"}]}',
    );
    const r = await runAudit(
      { output_to_audit: "x", auditor: "anthropic" },
      { providers: { anthropic: auditor } },
    ) as { items: { id: string; pass: boolean }[]; overall_score: number };
    expect(r.items).toHaveLength(6);
    expect(r.items[0]!.id).toBe("factual_grounding");
    expect(r.items[0]!.pass).toBe(true);
    expect(r.items[1]!.pass).toBe(false);
    // Overall = mean of 6 scores = (0.95 + 0 * 5) / 6
    expect(r.overall_score).toBeCloseTo(0.95 / 6, 8);
  });

  it("custom rubric replaces defaults", async () => {
    const auditor = fakeProvider("anthropic",
      '{"items":[{"id":"tone","score":0.8,"pass":true,"rationale":""}]}',
    );
    const r = await runAudit(
      { output_to_audit: "x", auditor: "anthropic",
        rubric: [{ id: "tone", description: "calm tone", severity: "low" }] },
      { providers: { anthropic: auditor } },
    ) as { rubric: { id: string }[]; items: { id: string }[] };
    expect(r.rubric).toEqual([{ id: "tone", description: "calm tone", severity: "low" }]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe("tone");
  });

  it("DEFAULT_AUDIT_RUBRICS is the 6-item set in canonical order", () => {
    expect(DEFAULT_AUDIT_RUBRICS).toHaveLength(6);
    expect(DEFAULT_AUDIT_RUBRICS.map((r) => r.id)).toEqual([
      "factual_grounding", "constraint_adherence", "no_pii_leak",
      "internally_consistent", "covers_open_questions", "actionability",
    ]);
  });
});
