// Native behavior tests for runRecall.
//
// No cross-language parity fixture here: Python emits raw bm25
// (lower-is-better) as `score`, while TS Storage normalizes to
// [0,1] (higher-is-better) by design. Both implementations preserve
// MATCH semantics + result ordering — those properties are what the
// unit tests assert. The `score` field's value differs intentionally
// and is documented in src/adapters/storage/interface.ts.

import { describe, expect, it, beforeEach } from "vitest";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runRecall } from "../../src/tools/recall.js";

import type { Storage } from "../../src/adapters/storage/interface.js";
import type { BridgeHandle } from "../../src/bridge/index.js";

let storage: Storage;

function seedTranscript(
  s: Storage,
  args: { path: string; session_id: string | null; tool: string; ts: number; content: string },
) {
  return s.indexTranscript(args);
}

const FIXED_NOW_S = 1_700_000_000;  // pinned epoch seconds for deterministic since_days

function fakeBridge(out: unknown = { tool: "recall", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["recall"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["recall"]),
    close: async () => { /* no-op */ },
  };
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
  // Seed a small corpus.
  await seedTranscript(storage, {
    path: "/tmp/t1.json",
    session_id: "sess-A",
    tool: "confer",
    ts: FIXED_NOW_S * 1000,
    content: "discuss postgres versus mysql for new service",
  });
  await seedTranscript(storage, {
    path: "/tmp/t2.json",
    session_id: "sess-A",
    tool: "debate",
    ts: (FIXED_NOW_S - 3 * 86400) * 1000,
    content: "rust adoption tradeoffs and ecosystem maturity",
  });
  await seedTranscript(storage, {
    path: "/tmp/t3.json",
    session_id: "sess-B",
    tool: "confer",
    ts: (FIXED_NOW_S - 30 * 86400) * 1000,
    content: "kubernetes cost optimization options",
  });
});

describe("runRecall — input gates", () => {
  it("missing query → RECALL_MISSING_QUERY", async () => {
    const r = await runRecall({}, { storage });
    expect((r as { error_code: string }).error_code).toBe("RECALL_MISSING_QUERY");
  });
  it("empty/whitespace query → RECALL_MISSING_QUERY", async () => {
    const r = await runRecall({ query: "  " }, { storage });
    expect((r as { error_code: string }).error_code).toBe("RECALL_MISSING_QUERY");
  });
  it("k clamps to [1, 50]", async () => {
    const lo = await runRecall(
      { query: "postgres", k: 0 }, { storage },
    ) as { applied_filters: { k: number } };
    expect(lo.applied_filters.k).toBe(1);
    const hi = await runRecall(
      { query: "postgres", k: 1000 }, { storage },
    ) as { applied_filters: { k: number } };
    expect(hi.applied_filters.k).toBe(50);
  });
});

describe("runRecall — search behavior", () => {
  it("returns matching row with snippet around the term", async () => {
    const r = await runRecall(
      { query: "postgres" }, { storage },
    ) as { rows: { snippet: string; tool: string; session_id: string }[]; count: number };
    expect(r.count).toBe(1);
    expect(r.rows[0]!.tool).toBe("confer");
    expect(r.rows[0]!.session_id).toBe("sess-A");
    expect(r.rows[0]!.snippet).toContain("[[postgres]]");
  });

  it("k caps the number of results", async () => {
    // 'discuss' / 'tradeoffs' / 'kubernetes' are 3 distinct hits across 3 rows.
    const r = await runRecall(
      { query: "discuss OR tradeoffs OR kubernetes", k: 2 },
      { storage },
    ) as { rows: unknown[]; count: number };
    expect(r.count).toBe(2);
  });

  it("session_id filter narrows results", async () => {
    const all = await runRecall(
      { query: "tool OR rust OR kubernetes" },
      { storage },
    ) as { count: number };
    const filtered = await runRecall(
      { query: "rust OR kubernetes", session_id: "sess-B" },
      { storage },
    ) as { rows: { session_id: string }[]; count: number };
    expect(filtered.count).toBe(1);
    expect(filtered.rows[0]!.session_id).toBe("sess-B");
    expect(all.count).toBeGreaterThanOrEqual(2);
  });

  it("tool filter narrows results", async () => {
    const r = await runRecall(
      { query: "discuss OR rust", tool: "confer" },
      { storage },
    ) as { rows: { tool: string }[] };
    for (const row of r.rows) expect(row.tool).toBe("confer");
  });

  it("since_days filter excludes older results", async () => {
    const now = () => FIXED_NOW_S;
    // 7-day window excludes the 30-day-old sess-B transcript.
    const r = await runRecall(
      { query: "postgres OR rust OR kubernetes", since_days: 7 },
      { storage, nowEpochSeconds: now },
    ) as { rows: { session_id: string }[]; count: number };
    expect(r.count).toBe(2);
    for (const row of r.rows) expect(row.session_id).toBe("sess-A");
  });

  it("applied_filters echoes the active filters", async () => {
    const r = await runRecall(
      { query: "x", k: 3, session_id: "sess-A", tool: "confer", since_days: 10 },
      { storage, nowEpochSeconds: () => FIXED_NOW_S },
    ) as { applied_filters: Record<string, unknown> };
    expect(r.applied_filters).toEqual({
      query: "x", k: 3, session_id: "sess-A", tool: "confer", since_days: 10,
    });
  });
});

describe("runRecall — no-storage paths", () => {
  it("no storage + no bridge → clear error", async () => {
    const r = await runRecall({ query: "x" }, {});
    expect((r as { error_code: string }).error_code).toBe("RECALL_STORAGE_NOT_NATIVE");
  });

  it("no storage + bridge → defers", async () => {
    const r = await runRecall(
      { query: "x" },
      { bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runRecall — output shape", () => {
  it("emits {tool, rows, count, applied_filters}", async () => {
    const r = await runRecall(
      { query: "kubernetes" }, { storage },
    ) as { tool: string; rows: { session_id: string; tool: string; ts: number; path: string; snippet: string; score: number }[]; count: number; applied_filters: { query: string; k: number } };
    expect(r.tool).toBe("recall");
    expect(r.applied_filters).toEqual({ query: "kubernetes", k: 5 });
    expect(r.count).toBe(1);
    const row = r.rows[0]!;
    expect(row.session_id).toBe("sess-B");
    expect(row.tool).toBe("confer");
    expect(row.path).toBe("/tmp/t3.json");
    expect(row.snippet.length).toBeGreaterThan(0);
    expect(typeof row.score).toBe("number");
    expect(typeof row.ts).toBe("number");
  });
});
