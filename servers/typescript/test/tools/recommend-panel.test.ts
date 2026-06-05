// Native behavior tests for runRecommendPanel.

import { describe, expect, it, beforeEach } from "vitest";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runRecommendPanel } from "../../src/tools/recommend-panel.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Storage } from "../../src/adapters/storage/interface.js";
import type { BridgeHandle } from "../../src/bridge/index.js";
import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

let storage: Storage;
const NOW = 1_700_000_000;
const nowEpochSeconds = () => NOW;

function fakeProvider(name: string, model: string): Provider {
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: "", attempts: 1,
      usage: emptyUsage(name, model, args.purpose ?? "worker"),
    }),
  };
}

function fakeBridge(out: unknown = { tool: "recommend_panel", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["recommend_panel"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["recommend_panel"]),
    close: async () => { /* no-op */ },
  };
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
});

describe("runRecommendPanel — gates", () => {
  it("missing purpose → RECOMMEND_PANEL_MISSING_PURPOSE", async () => {
    const r = await runRecommendPanel({}, { providers: {} });
    expect((r as { error_code: string }).error_code).toBe("RECOMMEND_PANEL_MISSING_PURPOSE");
  });
  it("no storage + no bridge → RECOMMEND_PANEL_STORAGE_NOT_NATIVE", async () => {
    const r = await runRecommendPanel({ purpose: "confer" }, { providers: {} });
    expect((r as { error_code: string }).error_code).toBe("RECOMMEND_PANEL_STORAGE_NOT_NATIVE");
  });
  it("no storage + bridge → defers", async () => {
    const r = await runRecommendPanel(
      { purpose: "confer" }, { providers: {}, bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runRecommendPanel — cold start", () => {
  it("empty usage_log → cold_start=true; ordered by win-rate then alpha", async () => {
    // Pre-seed provider_stats so cold-start has a signal.
    const at = NOW * 1000;
    // anthropic: 4 wins / 0 losses → weight 1.0
    for (let i = 0; i < 4; i++) await storage.bumpProviderBallot("anthropic", "agree", at);
    // openai:    1 win / 1 loss   → weight 0.5
    await storage.bumpProviderBallot("openai", "agree", at);
    await storage.bumpProviderBallot("openai", "disagree", at);
    // xai:       no stats yet → default weight 1.0
    // gemini:    0 wins / 1 loss → weight 0.0
    await storage.bumpProviderBallot("gemini", "disagree", at);

    const providers = {
      anthropic: fakeProvider("anthropic", "claude"),
      openai:    fakeProvider("openai",    "gpt-5"),
      xai:       fakeProvider("xai",       "grok"),
      gemini:    fakeProvider("gemini",    "gemini-2.5-pro"),
    };
    const r = await runRecommendPanel(
      { purpose: "confer", n: 4 },
      { providers, storage, nowEpochSeconds },
    ) as { recommended: { provider: string; score: number; model: string | null }[];
            meta: { cold_start: boolean; history_calls: number; n_available: number } };
    expect(r.meta.cold_start).toBe(true);
    expect(r.meta.history_calls).toBe(0);
    expect(r.meta.n_available).toBe(4);
    // Sort: -weight, then alpha. anthropic(1.0) + xai(1.0 default) tie
    // → alpha → anthropic, xai. Then openai (0.5), then gemini (0.0).
    expect(r.recommended.map((p) => p.provider)).toEqual([
      "anthropic", "xai", "openai", "gemini",
    ]);
    expect(r.recommended[0]!.model).toBe("claude");
    // Cold-start scores match the win-rate weight (rounded to 4 places).
    expect(r.recommended[0]!.score).toBe(1.0);
  });
});

describe("runRecommendPanel — warm path", () => {
  async function seedUsage(
    purpose: string, provider: string,
    n: number, costEach: number, tokensEach: number, wallMs: number,
    tsBase: number,
  ) {
    // usage_log has a NOT NULL FK on session_id — seed a session row
    // up-front so the inserts succeed.
    const sid = `seed-${purpose}-${provider}`;
    await storage.upsertSession({
      session_id: sid, started_at: tsBase, last_at: tsBase,
      calls: n, wall_ms: wallMs * n, cache_hits: 0,
      total_prompt_tokens: 0, total_completion_tokens: tokensEach * n,
      total_cached_tokens: 0, total_tokens: tokensEach * n,
      total_cost_usd: costEach * n, total_cpu_ms: 0,
    });
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        ts: tsBase + i * 1000, tool: null, purpose, provider, model: "m",
        prompt_tokens: 0, completion_tokens: tokensEach, total_tokens: tokensEach,
        cost_usd: costEach, estimated: 0, wall_ms: wallMs, cpu_ms: 0,
        session_id: sid, request_hash: null, error_kind: null,
      });
    }
    await storage.insertUsage(rows);
  }

  it("enough history → cold_start=false; cheaper provider scores higher", async () => {
    const tsBase = NOW * 1000;
    // 10 calls of anthropic, expensive ($0.01 each, ~500 tokens, slow 2000ms)
    // 10 calls of openai,    cheap ($0.001 each, ~500 tokens, fast 800ms)
    await seedUsage("confer", "anthropic", 10, 0.01,  500, 2000, tsBase);
    await seedUsage("confer", "openai",    10, 0.001, 500, 800,  tsBase);
    const providers = {
      anthropic: fakeProvider("anthropic", "claude"),
      openai:    fakeProvider("openai",    "gpt-5"),
    };
    const r = await runRecommendPanel(
      { purpose: "confer", n: 2 },
      { providers, storage, nowEpochSeconds },
    ) as {
      recommended: { provider: string; score: number; avg_cost_usd: number;
                     calls: number; rationale: string }[];
      meta: { cold_start: boolean; history_calls: number };
    };
    expect(r.meta.cold_start).toBe(false);
    expect(r.meta.history_calls).toBe(20);
    // Cheaper provider scores higher (cost_factor dominates after
    // reliability ties at 1.0 since error_rate is always 0 in TS v1).
    expect(r.recommended[0]!.provider).toBe("openai");
    expect(r.recommended[1]!.provider).toBe("anthropic");
    expect(r.recommended[0]!.score).toBeGreaterThan(r.recommended[1]!.score);
    // Rationale carries Python-equivalent format.
    expect(r.recommended[0]!.rationale).toContain("reliability=1.00");
    expect(r.recommended[0]!.rationale).toContain("calls=10");
    expect(r.recommended[0]!.rationale).toContain("avg_cost=$0.00100");
  });

  it("exclude filter removes providers", async () => {
    const tsBase = NOW * 1000;
    await seedUsage("confer", "anthropic", 10, 0.01,  500, 2000, tsBase);
    await seedUsage("confer", "openai",    10, 0.001, 500, 800,  tsBase);
    const providers = {
      anthropic: fakeProvider("anthropic", "claude"),
      openai:    fakeProvider("openai",    "gpt-5"),
    };
    const r = await runRecommendPanel(
      { purpose: "confer", n: 5, exclude: ["openai"] },
      { providers, storage, nowEpochSeconds },
    ) as { recommended: { provider: string }[]; meta: { n_available: number } };
    expect(r.recommended.map((p) => p.provider)).toEqual(["anthropic"]);
    expect(r.meta.n_available).toBe(1);
  });

  it("since_days narrows the history window", async () => {
    const tsBase = NOW * 1000;
    // Old records: 30 days back.
    await seedUsage("confer", "anthropic", 10, 0.01, 500, 2000, tsBase - 30 * 86400 * 1000);
    // Recent: today
    await seedUsage("confer", "openai", 2, 0.001, 500, 800, tsBase);
    const providers = {
      anthropic: fakeProvider("anthropic", "claude"),
      openai:    fakeProvider("openai",    "gpt-5"),
    };
    // since_days=7 → only openai's 2 calls visible.
    const r = await runRecommendPanel(
      { purpose: "confer", n: 5, since_days: 7 },
      { providers, storage, nowEpochSeconds },
    ) as { meta: { history_calls: number; cold_start: boolean; window_seconds: number } };
    expect(r.meta.history_calls).toBe(2);
    expect(r.meta.window_seconds).toBe(7 * 86400);
    expect(r.meta.cold_start).toBe(true);  // < 5-call cold-start threshold
  });

  it("available_only=false uses providers from stats (not registered)", async () => {
    const tsBase = NOW * 1000;
    await seedUsage("confer", "ghost-provider", 10, 0.001, 500, 800, tsBase);
    const r = await runRecommendPanel(
      { purpose: "confer", n: 5, available_only: false },
      { providers: {}, storage, nowEpochSeconds },
    ) as { recommended: { provider: string }[]; meta: { n_available: number } };
    expect(r.recommended).toHaveLength(1);
    expect(r.recommended[0]!.provider).toBe("ghost-provider");
    expect(r.meta.n_available).toBe(1);
  });
});

describe("runRecommendPanel — output shape", () => {
  it("emits {tool, recommended[], meta}", async () => {
    const r = await runRecommendPanel(
      { purpose: "confer", n: 1 },
      { providers: { a: fakeProvider("a", "m") }, storage, nowEpochSeconds },
    ) as { tool: string; recommended: unknown[]; meta: Record<string, unknown> };
    expect(r.tool).toBe("recommend_panel");
    expect(Array.isArray(r.recommended)).toBe(true);
    expect(typeof r.meta).toBe("object");
  });
});
