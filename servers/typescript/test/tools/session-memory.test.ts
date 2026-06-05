// Native behavior tests for runSessionMemory.
//
// Like recall, no cross-language parity fixture: the row shape is
// the same on both sides but `created_at`/`stale_at` timestamps are
// inherently per-environment. Native unit tests with in-memory
// better-sqlite3 prove the CRUD semantics.

import { describe, expect, it, beforeEach } from "vitest";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runSessionMemory } from "../../src/tools/session-memory.js";

import type { Storage } from "../../src/adapters/storage/interface.js";
import type { BridgeHandle } from "../../src/bridge/index.js";

let storage: Storage;

const FIXED_NOW_MS = 1_700_000_000_000;
const now = () => FIXED_NOW_MS;

function fakeBridge(out: unknown = { tool: "session_memory", from_bridge: true }): BridgeHandle {
  return {
    toolNames: new Set(["session_memory"]),
    pid: 99999,
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }),
    refreshTools: async () => new Set(["session_memory"]),
    close: async () => { /* no-op */ },
  };
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
});

describe("runSessionMemory — input gates", () => {
  it("missing action → SESSION_MEMORY_BAD_ACTION", async () => {
    const r = await runSessionMemory({ session_id: "s" }, { storage });
    expect((r as { error_code: string }).error_code).toBe("SESSION_MEMORY_BAD_ACTION");
  });
  it("unknown action → error mentions kind in repr", async () => {
    const r = await runSessionMemory(
      { action: "nuke", session_id: "s" }, { storage },
    ) as { error: string };
    expect(r.error).toContain("'nuke'");
  });
  it("missing session_id → SESSION_MEMORY_MISSING_SESSION_ID", async () => {
    const r = await runSessionMemory({ action: "list" }, { storage });
    expect((r as { error_code: string }).error_code).toBe("SESSION_MEMORY_MISSING_SESSION_ID");
  });

  it("no storage + no bridge → SESSION_MEMORY_STORAGE_NOT_NATIVE", async () => {
    const r = await runSessionMemory(
      { action: "list", session_id: "s" }, {},
    );
    expect((r as { error_code: string }).error_code).toBe("SESSION_MEMORY_STORAGE_NOT_NATIVE");
  });
  it("no storage + bridge → defers", async () => {
    const r = await runSessionMemory(
      { action: "list", session_id: "s" }, { bridge: fakeBridge() },
    );
    expect((r as { from_bridge: boolean }).from_bridge).toBe(true);
  });
});

describe("runSessionMemory — add", () => {
  it("happy path → returns new id", async () => {
    const r = await runSessionMemory(
      { action: "add", session_id: "s1",
        kind: "fact", content: "the sky is blue",
        source_tool: "confer", confidence: 0.9 },
      { storage, nowMs: now },
    ) as { action: string; id: number };
    expect(r.action).toBe("add");
    expect(typeof r.id).toBe("number");
    expect(r.id).toBeGreaterThan(0);
  });

  it("bad kind → SESSION_MEMORY_BAD_KIND with python-style repr", async () => {
    const r = await runSessionMemory(
      { action: "add", session_id: "s1",
        kind: "nope", content: "x" },
      { storage, nowMs: now },
    ) as { error_code: string; error: string };
    expect(r.error_code).toBe("SESSION_MEMORY_BAD_KIND");
    expect(r.error).toContain("'nope'");
  });

  it("empty content → SESSION_MEMORY_EMPTY_CONTENT", async () => {
    const r = await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "   " },
      { storage, nowMs: now },
    );
    expect((r as { error_code: string }).error_code).toBe("SESSION_MEMORY_EMPTY_CONTENT");
  });
});

describe("runSessionMemory — list", () => {
  it("returns inserted rows newest-first (DESC by id)", async () => {
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "fact-1" },
      { storage, nowMs: now },
    );
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "decision",
        content: "decided-X" },
      { storage, nowMs: now },
    );
    const r = await runSessionMemory(
      { action: "list", session_id: "s1" },
      { storage, nowMs: now },
    ) as { rows: { content: string; kind: string }[]; count: number };
    expect(r.count).toBe(2);
    // newest first.
    expect(r.rows.map((row) => row.kind)).toEqual(["decision", "fact"]);
  });

  it("kinds filter narrows the list", async () => {
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "fact-1" },
      { storage, nowMs: now },
    );
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "decision",
        content: "decided-X" },
      { storage, nowMs: now },
    );
    const r = await runSessionMemory(
      { action: "list", session_id: "s1", kinds: ["decision"] },
      { storage, nowMs: now },
    ) as { rows: { kind: string }[] };
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.kind).toBe("decision");
  });

  it("limit caps results", async () => {
    for (let i = 0; i < 5; i++) {
      await runSessionMemory(
        { action: "add", session_id: "s1", kind: "fact", content: `fact-${i}` },
        { storage, nowMs: now },
      );
    }
    const r = await runSessionMemory(
      { action: "list", session_id: "s1", limit: 3 },
      { storage, nowMs: now },
    ) as { rows: unknown[] };
    expect(r.rows).toHaveLength(3);
  });

  it("include_stale=false (default) hides stale rows", async () => {
    const a = await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "stale-target" },
      { storage, nowMs: now },
    ) as { id: number };
    await runSessionMemory(
      { action: "mark_stale", session_id: "s1", ids: [a.id], reason: "test" },
      { storage, nowMs: now },
    );
    const without = await runSessionMemory(
      { action: "list", session_id: "s1" },
      { storage, nowMs: now },
    ) as { count: number };
    expect(without.count).toBe(0);
    const withStale = await runSessionMemory(
      { action: "list", session_id: "s1", include_stale: true },
      { storage, nowMs: now },
    ) as { count: number };
    expect(withStale.count).toBe(1);
  });
});

describe("runSessionMemory — mark_stale + clear", () => {
  it("mark_stale by ids returns the affected count", async () => {
    const a = await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "a" },
      { storage, nowMs: now },
    ) as { id: number };
    const b = await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "b" },
      { storage, nowMs: now },
    ) as { id: number };
    const r = await runSessionMemory(
      { action: "mark_stale", session_id: "s1", ids: [a.id, b.id] },
      { storage, nowMs: now },
    ) as { marked_stale: number };
    expect(r.marked_stale).toBe(2);
  });

  it("mark_stale by kinds applies to all matching", async () => {
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "1" },
      { storage, nowMs: now },
    );
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "2" },
      { storage, nowMs: now },
    );
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "decision", content: "d" },
      { storage, nowMs: now },
    );
    const r = await runSessionMemory(
      { action: "mark_stale", session_id: "s1", kinds: ["fact"] },
      { storage, nowMs: now },
    ) as { marked_stale: number };
    expect(r.marked_stale).toBe(2);
  });

  it("clear deletes all rows for the session", async () => {
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "a" },
      { storage, nowMs: now },
    );
    await runSessionMemory(
      { action: "add", session_id: "s1", kind: "fact", content: "b" },
      { storage, nowMs: now },
    );
    const r = await runSessionMemory(
      { action: "clear", session_id: "s1" },
      { storage, nowMs: now },
    ) as { deleted: number };
    expect(r.deleted).toBe(2);

    const after = await runSessionMemory(
      { action: "list", session_id: "s1" },
      { storage, nowMs: now },
    ) as { count: number };
    expect(after.count).toBe(0);
  });
});
