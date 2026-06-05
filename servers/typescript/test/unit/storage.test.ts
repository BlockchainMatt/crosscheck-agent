// better-sqlite3 storage adapter — round-trip tests for every Storage
// method. Run on :memory: so each test starts from a known empty DB.
//
// Schema parity (TS-init DB vs Python-init DB) is verified separately
// in test/parity/schema_parity.test.ts; this file is just CRUD shape.

import { beforeEach, describe, expect, it } from "vitest";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import type { Storage } from "../../src/adapters/storage/interface.js";

async function freshDb(): Promise<Storage> {
  const s = openBetterSqliteStorage({ path: ":memory:" });
  await s.migrate();
  return s;
}

describe("migrations", () => {
  it("apply on first call, no-op on second", async () => {
    const s = await freshDb();
    const second = await s.migrate();
    expect(second.applied).toEqual([]);
    await s.close();
  });
});

describe("sessions", () => {
  let s: Storage;
  beforeEach(async () => (s = await freshDb()));

  it("upsert + get round-trips", async () => {
    await s.upsertSession({
      session_id: "alpha",
      started_at: 1_000,
      last_at: 2_000,
      calls: 5,
      wall_ms: 100,
      cache_hits: 0,
      total_prompt_tokens: 10,
      total_completion_tokens: 20,
      total_cached_tokens: 0,
      total_tokens: 30,
      total_cost_usd: 0.5,
      total_cpu_ms: 2,
    });
    const r = await s.getSession("alpha");
    expect(r?.session_id).toBe("alpha");
    expect(r?.total_tokens).toBe(30);
  });

  it("accumulate adds to existing totals", async () => {
    await s.accumulateSessionTotals("beta", {
      calls: 1,
      total_tokens: 100,
      total_cost_usd: 0.01,
      last_at: 5_000,
    });
    await s.accumulateSessionTotals("beta", {
      calls: 1,
      total_tokens: 200,
      total_cost_usd: 0.02,
      last_at: 6_000,
    });
    const r = await s.getSession("beta");
    expect(r?.calls).toBe(2);
    expect(r?.total_tokens).toBe(300);
    expect(r?.total_cost_usd).toBeCloseTo(0.03);
    expect(r?.last_at).toBe(6_000);
  });
});

describe("usage_log", () => {
  let s: Storage;
  beforeEach(async () => (s = await freshDb()));

  it("insert batch + list by session + group by purpose", async () => {
    await s.insertUsage([
      { session_id: "s1", ts: 1, tool: "confer", purpose: "confer",
        provider: "anthropic", model: "claude", total_tokens: 100, cost_usd: 0.1 },
      { session_id: "s1", ts: 2, tool: "confer", purpose: "confer",
        provider: "openai", model: "gpt", total_tokens: 200, cost_usd: 0.2 },
      { session_id: "s1", ts: 3, tool: "audit", purpose: "audit",
        provider: "gemini", model: "g25", total_tokens: 50, cost_usd: 0.05 },
    ]);
    const rows = await s.listUsageForSession("s1");
    expect(rows.length).toBe(3);

    const filtered = await s.listUsageForSession("s1", { only_purpose: ["audit"] });
    expect(filtered.length).toBe(1);

    const byPurpose = await s.listUsageGroupedByPurpose("s1");
    const confer = byPurpose.find((r) => r.purpose === "confer");
    expect(confer?.calls).toBe(2);
    expect(confer?.total_tokens).toBe(300);
  });
});

describe("claims + claim_links", () => {
  let s: Storage;
  beforeEach(async () => (s = await freshDb()));

  it("insert claims requires the session row (FK)", async () => {
    await s.upsertSession({
      session_id: "sx", started_at: 1, last_at: 1, calls: 0,
      wall_ms: 0, cache_hits: 0,
      total_prompt_tokens: 0, total_completion_tokens: 0,
      total_cached_tokens: 0, total_tokens: 0,
      total_cost_usd: 0, total_cpu_ms: 0,
    });
    const id1 = await s.insertClaim({
      session_id: "sx", text: "alpha", confidence: 0.9, kind: "consensus",
      citations: ["http://a"],
    });
    const id2 = await s.insertClaim({
      session_id: "sx", text: "beta", confidence: 0.5, kind: "support",
    });
    await s.insertClaimLink(id2, id1, "supports");
    const claims = await s.listClaimsForSession("sx");
    expect(claims.length).toBe(2);
    expect(JSON.parse(claims.find((c) => c.text === "alpha")!.citations_json!))
      .toEqual(["http://a"]);
    const links = await s.listClaimLinksForSession("sx");
    expect(links.length).toBe(1);
    expect(links[0]?.kind).toBe("supports");
  });

  it("rejects unknown link kinds", async () => {
    await expect(
      // @ts-expect-error — runtime guard
      s.insertClaimLink(1, 2, "bogus"),
    ).rejects.toThrow(/claim_link/);
  });
});

describe("provider_stats", () => {
  it("bump ballots and read back", async () => {
    const s = await freshDb();
    await s.bumpProviderBallot("anthropic", "agree", 100);
    await s.bumpProviderBallot("anthropic", "agree", 200);
    await s.bumpProviderBallot("anthropic", "disagree", 300);
    const r = await s.getProviderStats("anthropic");
    expect(r?.wins).toBe(2);
    expect(r?.losses).toBe(1);
    expect(r?.last_at).toBe(300);
  });
});

describe("session_memory", () => {
  let s: Storage;
  beforeEach(async () => (s = await freshDb()));

  it("insert + list excludes stale by default", async () => {
    const id = await s.insertSessionMemory({
      session_id: "m1", kind: "fact", content: "fact one", created_at: 1,
    });
    await s.insertSessionMemory({
      session_id: "m1", kind: "decision", content: "decision one", created_at: 2,
    });
    await s.markSessionMemoryStale("m1", 100, { ids: [id], reason: "test" });
    const live = await s.listSessionMemory("m1");
    expect(live.length).toBe(1);
    expect(live[0]?.kind).toBe("decision");
    const all = await s.listSessionMemory("m1", { include_stale: true });
    expect(all.length).toBe(2);
  });

  it("filter by kinds", async () => {
    await s.insertSessionMemory({ session_id: "m2", kind: "fact", content: "f", created_at: 1 });
    await s.insertSessionMemory({ session_id: "m2", kind: "decision", content: "d", created_at: 2 });
    const facts = await s.listSessionMemory("m2", { kinds: ["fact"] });
    expect(facts.length).toBe(1);
  });

  it("rejects unknown kinds", async () => {
    await expect(
      s.insertSessionMemory({
        // @ts-expect-error runtime guard
        session_id: "m3", kind: "bogus", content: "x", created_at: 1,
      }),
    ).rejects.toThrow(/session_memory/);
  });
});

describe("fetch_egress", () => {
  it("accumulates bytes per (session, host)", async () => {
    const s = await freshDb();
    await s.recordFetchEgress("s1", "example.com", 100, 1);
    await s.recordFetchEgress("s1", "example.com", 200, 2);
    await s.recordFetchEgress("s1", "another.io", 50, 3);
    const t = await s.getFetchEgressTotals("s1");
    expect(t.total_bytes).toBe(350);
    expect(t.unique_hosts).toBe(2);
  });
});

describe("transcripts_fts (recallSearch)", () => {
  it("indexes + searches with snippet", async () => {
    const s = await freshDb();
    await s.indexTranscript({
      path: "/tx/a.json", session_id: "s1", tool: "confer", ts: 1,
      content: "the quick brown fox jumps over the lazy dog",
    });
    await s.indexTranscript({
      path: "/tx/b.json", session_id: "s1", tool: "debate", ts: 2,
      content: "the rain in spain falls mainly on the plain",
    });
    const hits = await s.recallSearch("fox", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.path).toBe("/tx/a.json");
    expect(hits[0]?.snippet).toContain("[[fox]]");
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.score).toBeLessThanOrEqual(1);
  });

  it("filters by tool and session_id", async () => {
    const s = await freshDb();
    await s.indexTranscript({
      path: "a", session_id: "s1", tool: "confer", ts: 1, content: "alpha",
    });
    await s.indexTranscript({
      path: "b", session_id: "s2", tool: "confer", ts: 2, content: "alpha",
    });
    await s.indexTranscript({
      path: "c", session_id: "s1", tool: "debate", ts: 3, content: "alpha",
    });
    const inSession = await s.recallSearch("alpha", 10, { session_id: "s1" });
    expect(inSession.map((h) => h.path).sort()).toEqual(["a", "c"]);
    const oneTool = await s.recallSearch("alpha", 10, { tool: "confer" });
    expect(oneTool.map((h) => h.path).sort()).toEqual(["a", "b"]);
  });
});

describe("transactions", () => {
  it("commits on success", async () => {
    const s = await freshDb();
    await s.txn(async (t) => {
      await t.upsertSession({
        session_id: "tx-ok", started_at: 1, last_at: 1, calls: 1, wall_ms: 0,
        cache_hits: 0, total_prompt_tokens: 0, total_completion_tokens: 0,
        total_cached_tokens: 0, total_tokens: 0, total_cost_usd: 0, total_cpu_ms: 0,
      });
    });
    expect((await s.getSession("tx-ok"))?.session_id).toBe("tx-ok");
  });

  it("rolls back on throw", async () => {
    const s = await freshDb();
    await expect(
      s.txn(async (t) => {
        await t.upsertSession({
          session_id: "tx-fail", started_at: 1, last_at: 1, calls: 1, wall_ms: 0,
          cache_hits: 0, total_prompt_tokens: 0, total_completion_tokens: 0,
          total_cached_tokens: 0, total_tokens: 0, total_cost_usd: 0, total_cpu_ms: 0,
        });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(await s.getSession("tx-fail")).toBeNull();
  });
});

describe("canonicalSchema", () => {
  it("emits a deterministic, non-empty string for a fresh DB", async () => {
    const s1 = await freshDb();
    const s2 = await freshDb();
    const a = await s1.canonicalSchema();
    const b = await s2.canonicalSchema();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toContain("table:sessions");
    expect(a).toContain("table:usage_log");
    expect(a).toContain("table:claims");
    expect(a).toContain("table:session_memory");
    expect(a).toContain("table:fetch_egress");
    expect(a).toContain("fts:transcripts_fts");
  });
});
