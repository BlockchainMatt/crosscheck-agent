// Native behavior tests for runScoreboard.

import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runScoreboard } from "../../src/tools/scoreboard.js";

import type { Storage } from "../../src/adapters/storage/interface.js";
import type { BridgeHandle } from "../../src/bridge/index.js";

let storage: Storage;

function fakeBridge(out: unknown = { tool: "scoreboard", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["scoreboard"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["scoreboard"]),
    close: async () => { /* no-op */ },
  };
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
});

describe("runScoreboard — storage gating", () => {
  it("no storage + no bridge → SCOREBOARD_STORAGE_NOT_NATIVE", async () => {
    const r = await runScoreboard({}, {});
    expect((r as { error_code: string }).error_code).toBe("SCOREBOARD_STORAGE_NOT_NATIVE");
  });
  it("no storage + bridge → defers", async () => {
    const r = await runScoreboard({}, { bridge: fakeBridge() });
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runScoreboard — provider rows from ballots", () => {
  it("empty DB → empty providers + zero totals", async () => {
    const r = await runScoreboard({}, { storage }) as {
      providers: unknown[];
      totals: { sessions: number; claims: number; claim_links: number; delegations: number };
      recent_events: unknown[];
    };
    expect(r.providers).toEqual([]);
    expect(r.totals).toEqual({
      sessions: 0, claims: 0, claim_links: 0, delegations: 0,
    });
    expect(r.recent_events).toEqual([]);
  });

  it("weights = wins / (wins+losses), abstains excluded from denominator", async () => {
    // anthropic: 8W 2L 0A → 0.8
    // openai:    5W 5L 0A → 0.5
    // xai:       3W 1L 4A → 0.75
    // gemini:    0W 0L 1A → 1.0 (default, no committed ballots)
    const at = 1_700_000_000_000;
    for (let i = 0; i < 8; i++) await storage.bumpProviderBallot("anthropic", "agree", at);
    for (let i = 0; i < 2; i++) await storage.bumpProviderBallot("anthropic", "disagree", at);
    for (let i = 0; i < 5; i++) await storage.bumpProviderBallot("openai",    "agree", at);
    for (let i = 0; i < 5; i++) await storage.bumpProviderBallot("openai",    "disagree", at);
    for (let i = 0; i < 3; i++) await storage.bumpProviderBallot("xai",       "agree", at);
    for (let i = 0; i < 1; i++) await storage.bumpProviderBallot("xai",       "disagree", at);
    for (let i = 0; i < 4; i++) await storage.bumpProviderBallot("xai",       "abstain", at);
    await storage.bumpProviderBallot("gemini", "abstain", at);

    const r = await runScoreboard({}, { storage }) as {
      providers: { provider: string; weight: number; wins: number; losses: number; abstains: number }[];
    };
    // Sort: weight DESC, total_committed DESC, provider ASC.
    // anthropic 0.8 (10), xai 0.75 (4), openai 0.5 (10), gemini 1.0 (0, default).
    // Actually gemini has weight 1.0 (default) and 0 committed → comes FIRST.
    expect(r.providers.map((p) => p.provider)).toEqual([
      "gemini",     // 1.0, 0 committed → still first by weight
      "anthropic",  // 0.8, 10 committed
      "xai",        // 0.75, 4 committed
      "openai",     // 0.5, 10 committed
    ]);
    expect(r.providers[0]!.weight).toBe(1.0);
    expect(r.providers[1]!.weight).toBe(0.8);
    expect(r.providers[2]!.weight).toBe(0.75);
    expect(r.providers[3]!.weight).toBe(0.5);
  });

  it("delegation-only providers appended with weight=1.0, zero ballot fields", async () => {
    const at = 1_700_000_000_000;
    await storage.insertDelegation({
      session_id: "s1", requester: "mystery-provider", tool_call: "confer",
      via: "anthropic", accepted: 1, created_at: at,
    });
    const r = await runScoreboard({}, { storage }) as {
      providers: { provider: string; weight: number; wins: number; delegations_accepted: number }[];
    };
    const row = r.providers.find((p) => p.provider === "mystery-provider");
    expect(row).toBeDefined();
    expect(row!.weight).toBe(1.0);
    expect(row!.wins).toBe(0);
    expect(row!.delegations_accepted).toBe(1);
  });

  it("delegation counts attach to existing ballot-stats rows", async () => {
    const at = 1_700_000_000_000;
    await storage.bumpProviderBallot("anthropic", "agree", at);
    await storage.insertDelegation({
      session_id: "s1", requester: "anthropic", tool_call: "confer",
      via: "openai", accepted: 1, created_at: at,
    });
    await storage.insertDelegation({
      session_id: "s1", requester: "anthropic", tool_call: "confer",
      via: "openai", accepted: 0, created_at: at,
    });
    const r = await runScoreboard({}, { storage }) as {
      providers: { provider: string; delegations_accepted: number; delegations_refused: number }[];
    };
    const row = r.providers.find((p) => p.provider === "anthropic")!;
    expect(row.delegations_accepted).toBe(1);
    expect(row.delegations_refused).toBe(1);
  });

  it("top_k clamps the providers list", async () => {
    const at = 1_700_000_000_000;
    for (const n of ["a", "b", "c", "d"]) {
      await storage.bumpProviderBallot(n, "agree", at);
    }
    const r = await runScoreboard({ top_k: 2 }, { storage }) as {
      providers: unknown[];
    };
    expect(r.providers).toHaveLength(2);
  });
});

describe("runScoreboard — totals", () => {
  it("counts sessions / delegations correctly", async () => {
    const at = 1_700_000_000_000;
    await storage.upsertSession({
      session_id: "s1", started_at: at, last_at: at,
      calls: 0, wall_ms: 0, cache_hits: 0,
      total_prompt_tokens: 0, total_completion_tokens: 0,
      total_cached_tokens: 0, total_tokens: 0,
      total_cost_usd: 0.0, total_cpu_ms: 0,
    });
    await storage.upsertSession({
      session_id: "s2", started_at: at, last_at: at,
      calls: 0, wall_ms: 0, cache_hits: 0,
      total_prompt_tokens: 0, total_completion_tokens: 0,
      total_cached_tokens: 0, total_tokens: 0,
      total_cost_usd: 0.0, total_cpu_ms: 0,
    });
    await storage.insertDelegation({
      session_id: "s1", requester: "anthropic", tool_call: "confer",
      via: "openai", accepted: 1, created_at: at,
    });

    const r = await runScoreboard({}, { storage }) as {
      totals: { sessions: number; delegations: number };
    };
    expect(r.totals.sessions).toBe(2);
    expect(r.totals.delegations).toBe(1);
  });
});

describe("runScoreboard — recent_events", () => {
  let tmpDir: string;
  let evPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "scoreboard-"));
    evPath = path.join(tmpDir, "events.jsonl");
  });

  it("recent_limit=0 → empty array, file not read", async () => {
    writeFileSync(evPath,
      '{"k":"a"}\n{"k":"b"}\n{"k":"c"}\n');
    const r = await runScoreboard(
      { recent_limit: 0 }, { storage, eventsPath: evPath },
    ) as { recent_events: unknown[] };
    expect(r.recent_events).toEqual([]);
    rmSync(tmpDir, { recursive: true });
  });

  it("tails the last N lines as JSON", async () => {
    writeFileSync(evPath,
      '{"k":"a"}\n{"k":"b"}\n{"k":"c"}\n{"k":"d"}\n');
    const r = await runScoreboard(
      { recent_limit: 2 }, { storage, eventsPath: evPath },
    ) as { recent_events: { k: string }[] };
    expect(r.recent_events.map((e) => e.k)).toEqual(["c", "d"]);
    rmSync(tmpDir, { recursive: true });
  });

  it("skips malformed lines, matches Python json.JSONDecodeError handling", async () => {
    writeFileSync(evPath,
      '{"ok":1}\nnot-json\n{"ok":2}\n');
    const r = await runScoreboard(
      { recent_limit: 10 }, { storage, eventsPath: evPath },
    ) as { recent_events: { ok: number }[] };
    expect(r.recent_events).toHaveLength(2);
    expect(r.recent_events.map((e) => e.ok)).toEqual([1, 2]);
    rmSync(tmpDir, { recursive: true });
  });

  it("missing file → empty recent_events", async () => {
    const r = await runScoreboard(
      { recent_limit: 10 },
      { storage, eventsPath: "/nonexistent/path.jsonl" },
    ) as { recent_events: unknown[] };
    expect(r.recent_events).toEqual([]);
  });
});
