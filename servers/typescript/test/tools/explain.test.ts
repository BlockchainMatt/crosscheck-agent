// Native behavior tests for runExplain.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runExplain } from "../../src/tools/explain.js";

import type { Storage } from "../../src/adapters/storage/interface.js";
import type { BridgeHandle } from "../../src/bridge/index.js";

let storage: Storage;
let tmpDir: string;

function fakeBridge(out: unknown = { tool: "explain", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["explain"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["explain"]),
    close: async () => { /* no-op */ },
  };
}

async function seedSession(s: Storage, sessionId: string) {
  await s.upsertSession({
    session_id:              sessionId,
    started_at:              1_700_000_000_000,
    last_at:                 1_700_000_005_000,
    calls:                   3,
    wall_ms:                 5000,
    cache_hits:              0,
    total_prompt_tokens:     300,
    total_completion_tokens: 150,
    total_cached_tokens:     0,
    total_tokens:            450,
    total_cost_usd:          0.0125,
    total_cpu_ms:            120,
  });
  await s.insertUsage([
    { ts: 1_700_000_001_000, tool: "confer", purpose: "worker",
      provider: "anthropic", model: "claude", prompt_tokens: 100,
      completion_tokens: 50, total_tokens: 150, cost_usd: 0.005,
      estimated: 0, wall_ms: 1000, cpu_ms: 40, session_id: sessionId,
      request_hash: null, error_kind: null },
    { ts: 1_700_000_002_000, tool: "confer", purpose: "worker",
      provider: "openai", model: "gpt-5", prompt_tokens: 100,
      completion_tokens: 50, total_tokens: 150, cost_usd: 0.004,
      estimated: 0, wall_ms: 2000, cpu_ms: 40, session_id: sessionId,
      request_hash: null, error_kind: null },
    { ts: 1_700_000_003_000, tool: "audit",  purpose: "audit",
      provider: "anthropic", model: "claude", prompt_tokens: 100,
      completion_tokens: 50, total_tokens: 150, cost_usd: 0.0035,
      estimated: 0, wall_ms: 2000, cpu_ms: 40, session_id: sessionId,
      request_hash: null, error_kind: null },
  ]);
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
  tmpDir = mkdtempSync(path.join(tmpdir(), "explain-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runExplain — gates", () => {
  it("missing session_id → EXPLAIN_MISSING_SESSION_ID", async () => {
    const r = await runExplain({}, { storage });
    expect((r as { error_code: string }).error_code).toBe("EXPLAIN_MISSING_SESSION_ID");
  });
  it("no storage + no bridge → EXPLAIN_STORAGE_NOT_NATIVE", async () => {
    const r = await runExplain({ session_id: "s" }, {});
    expect((r as { error_code: string }).error_code).toBe("EXPLAIN_STORAGE_NOT_NATIVE");
  });
  it("no storage + bridge → defers", async () => {
    const r = await runExplain({ session_id: "s" }, { bridge: fakeBridge() });
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
  it("session not in DB → EXPLAIN_NO_SESSION + python-repr session_id", async () => {
    const r = await runExplain(
      { session_id: "ghost" }, { storage },
    ) as { error_code: string; error: string; session_id: string };
    expect(r.error_code).toBe("EXPLAIN_NO_SESSION");
    expect(r.error).toContain("'ghost'");
    expect(r.session_id).toBe("ghost");
  });
});

describe("runExplain — happy path", () => {
  it("returns rows + totals + rollups + ascii tree by default", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1" }, { storage },
    ) as {
      tool: string; session_id: string;
      totals: { calls: number; wall_ms: number; total_tokens: number;
                total_cost_usd: number; cache_hits: number };
      by_purpose: Record<string, { calls: number; tokens: number; cost_usd: number }>;
      by_provider: Record<string, { calls: number; tokens: number; cost_usd: number }>;
      rows: unknown[];
      transcripts: unknown[];
      text: string;
    };
    expect(r.tool).toBe("explain");
    expect(r.session_id).toBe("s1");
    expect(r.rows).toHaveLength(3);
    expect(r.totals.calls).toBe(3);
    expect(r.totals.total_tokens).toBe(450);
    expect(r.totals.total_cost_usd).toBeCloseTo(0.0125, 6);
    // by_purpose: worker has 2 rows (cost 0.005+0.004); audit has 1 (0.0035).
    expect(r.by_purpose["worker"]!.calls).toBe(2);
    expect(r.by_purpose["audit"]!.calls).toBe(1);
    // by_provider: anthropic has 2 rows (worker + audit); openai has 1.
    expect(r.by_provider["anthropic"]!.calls).toBe(2);
    expect(r.by_provider["openai"]!.calls).toBe(1);
    expect(r.transcripts).toEqual([]);
    expect(r.text).toContain("session: s1");
    expect(r.text).toContain("anthropic:claude");
    expect(r.text).toContain("$0.0125");  // Python totals format
  });

  it("include_text=false omits text field", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1", include_text: false }, { storage },
    ) as Record<string, unknown>;
    expect("text" in r).toBe(false);
  });
});

describe("runExplain — filters", () => {
  it("only_purpose narrows rows + rollups", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1", only_purpose: ["audit"] }, { storage },
    ) as {
      rows: { purpose: string }[];
      by_purpose: Record<string, unknown>;
      by_provider: Record<string, unknown>;
      applied_filters: { only_purpose: string[]; only_provider: string[] | null };
    };
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.purpose).toBe("audit");
    expect(Object.keys(r.by_purpose)).toEqual(["audit"]);
    expect(r.applied_filters.only_purpose).toEqual(["audit"]);
    expect(r.applied_filters.only_provider).toBeNull();
  });

  it("only_provider narrows rows + rollups", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1", only_provider: ["openai"] }, { storage },
    ) as {
      rows: { provider: string }[];
      by_provider: Record<string, unknown>;
      applied_filters: { only_purpose: string[] | null; only_provider: string[] };
    };
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.provider).toBe("openai");
    expect(Object.keys(r.by_provider)).toEqual(["openai"]);
    expect(r.applied_filters.only_provider).toEqual(["openai"]);
    expect(r.applied_filters.only_purpose).toBeNull();
  });

  it("both filters combine (AND)", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1",
        only_purpose: ["audit"],
        only_provider: ["anthropic"] },
      { storage },
    ) as { rows: unknown[]; applied_filters: { only_purpose: string[]; only_provider: string[] } };
    expect(r.rows).toHaveLength(1);
    expect(r.applied_filters.only_purpose).toEqual(["audit"]);
    expect(r.applied_filters.only_provider).toEqual(["anthropic"]);
  });

  it("no filters → no applied_filters field", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1" }, { storage },
    ) as Record<string, unknown>;
    expect("applied_filters" in r).toBe(false);
  });
});

describe("runExplain — transcript dir", () => {
  it("missing dir → empty transcripts list", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1" },
      { storage, transcriptsDir: path.join(tmpDir, "does-not-exist") },
    ) as { transcripts: unknown[] };
    expect(r.transcripts).toEqual([]);
  });

  it("walks dir + matches by session.session_id", async () => {
    await seedSession(storage, "s1");
    // Two transcripts: one matches, one doesn't.
    writeFileSync(path.join(tmpDir, "a.json"), JSON.stringify({
      tool: "confer",
      session: { session_id: "s1" },
      question: "What's up?",
      answers: [{ provider: "anthropic" }, { provider: "openai" }],
    }));
    writeFileSync(path.join(tmpDir, "b.json"), JSON.stringify({
      tool: "confer",
      session: { session_id: "other-session" },
      question: "wrong",
      answers: [],
    }));
    const r = await runExplain(
      { session_id: "s1" }, { storage, transcriptsDir: tmpDir },
    ) as { transcripts: { tool: string; question: string; providers: string[] }[] };
    expect(r.transcripts).toHaveLength(1);
    expect(r.transcripts[0]!.tool).toBe("confer");
    expect(r.transcripts[0]!.question).toBe("What's up?");
    expect(r.transcripts[0]!.providers).toEqual(["anthropic", "openai"]);
  });

  it("max_transcripts caps the list", async () => {
    await seedSession(storage, "s1");
    // Create 5 matching transcripts with monotonically increasing mtimes.
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(tmpDir, `t${i}.json`), JSON.stringify({
        tool: "confer", session: { session_id: "s1" },
        question: `q${i}`, answers: [],
      }));
    }
    const r = await runExplain(
      { session_id: "s1", max_transcripts: 3 },
      { storage, transcriptsDir: tmpDir },
    ) as { transcripts: unknown[] };
    expect(r.transcripts).toHaveLength(3);
  });

  it("per-tool summary shapes: confer / debate / audit / orchestrate", async () => {
    await seedSession(storage, "s1");
    writeFileSync(path.join(tmpDir, "c.json"), JSON.stringify({
      tool: "debate", session: { session_id: "s1" },
      topic: "should we?", rounds_completed: 2, claims: [{}, {}],
    }));
    writeFileSync(path.join(tmpDir, "a.json"), JSON.stringify({
      tool: "audit", session: { session_id: "s1" },
      mode: "single", overall_score: 0.8, passed: true,
      obvious_failures: [], disagreements: [],
    }));
    writeFileSync(path.join(tmpDir, "o.json"), JSON.stringify({
      tool: "orchestrate", session: { session_id: "s1" },
      nodes: [{ status: "ok" }, { status: "failed" }, { status: "ok" }],
      partial: false, cheap_mode: false,
    }));
    const r = await runExplain(
      { session_id: "s1" },
      { storage, transcriptsDir: tmpDir },
    ) as { transcripts: Record<string, unknown>[] };
    const byTool: Record<string, Record<string, unknown>> = {};
    for (const t of r.transcripts) byTool[t["tool"] as string] = t;
    expect(byTool["debate"]!.topic).toBe("should we?");
    expect(byTool["debate"]!.rounds_completed).toBe(2);
    expect(byTool["debate"]!.claims_count).toBe(2);
    expect(byTool["audit"]!.mode).toBe("single");
    expect(byTool["audit"]!.overall_score).toBe(0.8);
    expect(byTool["audit"]!.passed).toBe(true);
    expect(byTool["orchestrate"]!.nodes_run).toBe(3);
    expect(byTool["orchestrate"]!.nodes_ok).toBe(2);
    expect(byTool["orchestrate"]!.nodes_failed).toBe(1);
  });

  it("skips malformed JSON files (matches Python try/except)", async () => {
    await seedSession(storage, "s1");
    writeFileSync(path.join(tmpDir, "bad.json"), "not json");
    writeFileSync(path.join(tmpDir, "good.json"), JSON.stringify({
      tool: "confer", session: { session_id: "s1" },
      question: "q", answers: [],
    }));
    const r = await runExplain(
      { session_id: "s1" },
      { storage, transcriptsDir: tmpDir },
    ) as { transcripts: unknown[] };
    expect(r.transcripts).toHaveLength(1);
  });
});

describe("runExplain — ASCII tree", () => {
  it("groups rows by tool with branch markers", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1" }, { storage },
    ) as { text: string };
    // Two tool groups → first uses |- second uses `-.
    expect(r.text).toMatch(/\|- confer/);
    expect(r.text).toMatch(/`- audit/);
    // Each call gets a sub-marker.
    expect(r.text).toContain("anthropic:claude");
    expect(r.text).toContain("openai:gpt-5");
  });

  it("formats numbers with Python-style fixed precision", async () => {
    await seedSession(storage, "s1");
    const r = await runExplain(
      { session_id: "s1" }, { storage },
    ) as { text: string };
    // Header: total cost 0.0125 rendered as $0.0125 (4 decimals).
    expect(r.text).toContain("$0.0125");
    // Wall 5000 ms → 5.0s wall (1 decimal).
    expect(r.text).toContain("5.0s wall");
    // CPU 120 ms → 0.120s cpu (3 decimals).
    expect(r.text).toContain("0.120s cpu");
  });
});
