// better-sqlite3 adapter. Sync work under the hood (better-sqlite3 is
// sync-only); every method returns a Promise.resolve() so the Storage
// interface stays async-uniform with the wa-sqlite/OPFS adapter.
//
// Owns:
//   - PRAGMA setup: journal_mode=WAL, synchronous=NORMAL, busy_timeout,
//     foreign_keys=ON.
//   - Prepared-statement cache (Database#prepare returns cached
//     statements automatically; we keep the resulting Statement objects
//     on `this` for hot-path queries).
//   - Migration runner that applies the ordered list inside a single
//     transaction per migration and records applied ids.

import DatabaseCtor from "better-sqlite3";
import type { Database as BetterDb, Statement } from "better-sqlite3";

import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { canonicalSchema, type SchemaReader } from "./schema.js";
import type {
  ClaimInsert,
  ClaimLinkKind,
  ClaimLinkRow,
  ClaimRow,
  DelegationRow,
  FetchEgressRow,
  ListSessionMemoryOpts,
  MarkStaleOpts,
  ProviderStatsRow,
  RecallSearchOpts,
  SearchHit,
  SessionMemoryInsert,
  SessionMemoryKind,
  SessionMemoryRow,
  SessionRow,
  Storage,
  Txn,
  UnsafeStorage,
  UsageLogInsert,
  UsageLogRow,
} from "./interface.js";

const ALLOWED_LINK_KINDS: ReadonlySet<ClaimLinkKind> = new Set([
  "supports",
  "attacks",
  "derives_from",
  "merges_with",
]);

const ALLOWED_MEMORY_KINDS: ReadonlySet<SessionMemoryKind> = new Set([
  "fact",
  "open_question",
  "decision",
]);

export interface BetterSqliteAdapterOptions {
  /** Path to the SQLite file. `":memory:"` for an ephemeral DB. */
  path: string;
  /** `busy_timeout` PRAGMA (default 5000 ms — matches Python's choice
   *  during the Phase-4 bridge work). */
  busyTimeoutMs?: number;
  /** Set to false to skip WAL setup (useful for :memory:). Defaults to
   *  true unless path == ":memory:". */
  wal?: boolean;
}

export function openBetterSqliteStorage(
  opts: BetterSqliteAdapterOptions,
): Storage {
  const db = new DatabaseCtor(opts.path);
  const wantWal = opts.wal ?? opts.path !== ":memory:";
  if (wantWal) db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  db.pragma("foreign_keys = ON");
  return new BetterSqliteStorage(db);
}

// ----------------------------------------------------------------------
// Implementation. The class implements both the public Storage surface
// and the inner Txn surface (within `txn(fn)` we wrap calls in a
// transaction via better-sqlite3's `db.transaction()`).
// ----------------------------------------------------------------------

class BetterSqliteStorage implements Storage {
  private readonly stmts = new Map<string, Statement>();

  constructor(private readonly db: BetterDb) {}

  // ------------------------------------------------------------------
  // Lifecycle / lifetime
  // ------------------------------------------------------------------

  async migrate(): Promise<{ applied: readonly string[] }> {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const existing = new Set(
      (
        this.db
          .prepare<unknown[], { id: string }>("SELECT id FROM schema_migrations")
          .all() as { id: string }[]
      ).map((r) => r.id),
    );
    const applied: string[] = [];
    // Migrations are immutable + idempotent — apply in id order.
    const ordered = [...MIGRATIONS].sort((a, b) => a.id.localeCompare(b.id));
    for (const m of ordered) {
      if (existing.has(m.id)) continue;
      this.applyMigration(m);
      applied.push(m.id);
    }
    return { applied };
  }

  private applyMigration(m: Migration): void {
    const txn = this.db.transaction(() => {
      for (const stmt of m.up) this.db.exec(stmt);
      this.db
        .prepare(
          "INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)",
        )
        .run(m.id, Date.now());
    });
    txn();
  }

  async canonicalSchema(): Promise<string> {
    const reader: SchemaReader = {
      pragma: (name, arg) =>
        arg === undefined
          ? (this.db.pragma(name) as Record<string, unknown>[])
          : (this.db.pragma(`${name}('${arg.replace(/'/g, "''")}')`) as Record<
              string,
              unknown
            >[]),
      list: (sql) =>
        this.db.prepare(sql).all() as Record<string, unknown>[],
    };
    return canonicalSchema(reader);
  }

  unsafe(): UnsafeStorage {
    return {
      exec: async (sql, params) => {
        const stmt = this.db.prepare(sql);
        const info = stmt.run(...(params ?? []));
        return Number(info.changes);
      },
      query: async (sql, params) =>
        this.db.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[],
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Transactions. better-sqlite3 supports nested transactions via
  // SAVEPOINTs automatically when the outer caller is already inside
  // db.transaction(). We expose a Txn that mirrors Storage's surface;
  // every method call inside the callback runs inside the open txn.
  // ------------------------------------------------------------------

  async txn<T>(fn: (txn: Txn) => Promise<T>): Promise<T> {
    // Manual BEGIN IMMEDIATE / COMMIT / ROLLBACK rather than better-
    // sqlite3's `db.transaction()` — that wrapper insists on a sync
    // callback, which doesn't compose with our async Storage interface.
    //
    // Safe here because: every adapter method does synchronous better-
    // sqlite3 work wrapped in Promise.resolve(), so `await fn(this)`
    // unwraps within the same microtask flush — the txn does not stay
    // open across real event-loop ticks unless the user fn deliberately
    // does I/O (which would be a misuse — callers should keep txn
    // bodies tight).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ROLLBACK can fail if the txn was already auto-rolled back
        // (e.g. SQLITE_BUSY). Swallow so we surface the original error.
      }
      throw e;
    }
  }

  // ==================================================================
  // sessions
  // ==================================================================

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const row = this.cached(
      "session-get",
      "SELECT * FROM sessions WHERE session_id = ?",
    ).get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  async listSessions(opts?: { limit?: number }): Promise<readonly SessionRow[]> {
    const limit = opts?.limit ?? 100;
    return this.cached(
      "session-list",
      "SELECT * FROM sessions ORDER BY last_at DESC LIMIT ?",
    ).all(limit) as SessionRow[];
  }

  async upsertSession(row: SessionRow): Promise<void> {
    this.cached(
      "session-upsert",
      `INSERT INTO sessions
         (session_id, started_at, last_at, calls, wall_ms, cache_hits,
          total_prompt_tokens, total_completion_tokens, total_cached_tokens,
          total_tokens, total_cost_usd, total_cpu_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_at = excluded.last_at,
         calls = excluded.calls,
         wall_ms = excluded.wall_ms,
         cache_hits = excluded.cache_hits,
         total_prompt_tokens = excluded.total_prompt_tokens,
         total_completion_tokens = excluded.total_completion_tokens,
         total_cached_tokens = excluded.total_cached_tokens,
         total_tokens = excluded.total_tokens,
         total_cost_usd = excluded.total_cost_usd,
         total_cpu_ms = excluded.total_cpu_ms`,
    ).run(
      row.session_id,
      row.started_at,
      row.last_at,
      row.calls,
      row.wall_ms,
      row.cache_hits,
      row.total_prompt_tokens,
      row.total_completion_tokens,
      row.total_cached_tokens,
      row.total_tokens,
      row.total_cost_usd,
      row.total_cpu_ms,
    );
  }

  async accumulateSessionTotals(
    sessionId: string,
    delta: Parameters<Storage["accumulateSessionTotals"]>[1],
  ): Promise<void> {
    // First make sure the row exists; otherwise the UPDATE no-ops silently.
    this.cached(
      "session-touch",
      `INSERT OR IGNORE INTO sessions
         (session_id, started_at, last_at, calls, wall_ms, cache_hits)
       VALUES (?, ?, ?, 0, 0, 0)`,
    ).run(sessionId, delta.last_at ?? 0, delta.last_at ?? null);
    this.cached(
      "session-acc",
      `UPDATE sessions SET
         calls = calls + ?,
         wall_ms = wall_ms + ?,
         cache_hits = cache_hits + ?,
         total_prompt_tokens = total_prompt_tokens + ?,
         total_completion_tokens = total_completion_tokens + ?,
         total_cached_tokens = total_cached_tokens + ?,
         total_tokens = total_tokens + ?,
         total_cost_usd = total_cost_usd + ?,
         total_cpu_ms = total_cpu_ms + ?,
         last_at = COALESCE(?, last_at)
       WHERE session_id = ?`,
    ).run(
      delta.calls ?? 0,
      delta.wall_ms ?? 0,
      delta.cache_hits ?? 0,
      delta.total_prompt_tokens ?? 0,
      delta.total_completion_tokens ?? 0,
      delta.total_cached_tokens ?? 0,
      delta.total_tokens ?? 0,
      delta.total_cost_usd ?? 0,
      delta.total_cpu_ms ?? 0,
      delta.last_at ?? null,
      sessionId,
    );
  }

  // ==================================================================
  // usage_log
  // ==================================================================

  async insertUsage(rows: readonly UsageLogInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const stmt = this.cached(
      "usage-insert",
      `INSERT INTO usage_log
         (session_id, ts, tool, purpose, provider, model,
          prompt_tokens, completion_tokens, cached_tokens, total_tokens,
          cost_usd, estimated, wall_ms, cpu_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((items: readonly UsageLogInsert[]) => {
      for (const r of items) {
        stmt.run(
          r.session_id,
          r.ts,
          r.tool,
          r.purpose,
          r.provider,
          r.model,
          r.prompt_tokens ?? 0,
          r.completion_tokens ?? 0,
          r.cached_tokens ?? 0,
          r.total_tokens ?? 0,
          r.cost_usd ?? 0,
          r.estimated ?? 0,
          r.wall_ms ?? 0,
          r.cpu_ms ?? 0,
        );
      }
    });
    tx(rows);
  }

  async listUsageForSession(
    sessionId: string,
    opts?: Parameters<Storage["listUsageForSession"]>[1],
  ): Promise<readonly UsageLogRow[]> {
    // Dynamic IN-clause length means we can't fully cache the prepared
    // statement — build per-call but reuse the rest. For Phase 1 this is
    // simple; later we'll memoize by signature.
    const where: string[] = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (opts?.only_purpose && opts.only_purpose.length > 0) {
      where.push(`purpose IN (${opts.only_purpose.map(() => "?").join(",")})`);
      params.push(...opts.only_purpose);
    }
    if (opts?.only_provider && opts.only_provider.length > 0) {
      where.push(`provider IN (${opts.only_provider.map(() => "?").join(",")})`);
      params.push(...opts.only_provider);
    }
    const limit = opts?.limit ?? 1000;
    params.push(limit);
    const sql = `SELECT * FROM usage_log WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`;
    return this.db.prepare(sql).all(...params) as UsageLogRow[];
  }

  async listUsageGroupedByPurpose(
    sessionId: string,
  ): Promise<
    Awaited<ReturnType<Storage["listUsageGroupedByPurpose"]>>
  > {
    return this.cached(
      "usage-grp-purpose",
      `SELECT purpose,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),     0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens),      0) AS total_tokens,
              COALESCE(SUM(cost_usd),          0) AS cost_usd,
              COALESCE(SUM(wall_ms),           0) AS wall_ms,
              COALESCE(SUM(cpu_ms),            0) AS cpu_ms
       FROM usage_log
       WHERE session_id = ?
       GROUP BY purpose
       ORDER BY purpose`,
    ).all(sessionId) as Awaited<ReturnType<Storage["listUsageGroupedByPurpose"]>>;
  }

  async listUsageGroupedByProvider(
    purpose?: string,
  ): Promise<
    Awaited<ReturnType<Storage["listUsageGroupedByProvider"]>>
  > {
    if (purpose !== undefined) {
      return this.cached(
        "usage-grp-provider-p",
        `SELECT provider,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd),     0) AS cost_usd,
                0 AS errors
         FROM usage_log
         WHERE purpose = ?
         GROUP BY provider
         ORDER BY provider`,
      ).all(purpose) as Awaited<
        ReturnType<Storage["listUsageGroupedByProvider"]>
      >;
    }
    return this.cached(
      "usage-grp-provider",
      `SELECT provider,
              COUNT(*) AS calls,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost_usd),     0) AS cost_usd,
              0 AS errors
       FROM usage_log
       GROUP BY provider
       ORDER BY provider`,
    ).all() as Awaited<ReturnType<Storage["listUsageGroupedByProvider"]>>;
  }

  // ==================================================================
  // claims
  // ==================================================================

  async insertClaim(claim: ClaimInsert): Promise<number> {
    const info = this.cached(
      "claim-insert",
      `INSERT INTO claims
         (session_id, text, provider, confidence, citations_json, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      claim.session_id,
      claim.text,
      claim.provider ?? null,
      claim.confidence ?? null,
      claim.citations ? JSON.stringify(claim.citations) : null,
      claim.kind ?? null,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  async insertClaimLink(
    srcId: number,
    dstId: number,
    kind: ClaimLinkKind,
  ): Promise<void> {
    if (!ALLOWED_LINK_KINDS.has(kind)) {
      throw new RangeError(`invalid claim_link kind: ${kind}`);
    }
    this.cached(
      "claim-link-insert",
      `INSERT OR IGNORE INTO claim_links (src_id, dst_id, kind, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(srcId, dstId, kind, Date.now());
  }

  async listClaimsForSession(sessionId: string): Promise<readonly ClaimRow[]> {
    return this.cached(
      "claim-list-session",
      "SELECT * FROM claims WHERE session_id = ? ORDER BY id",
    ).all(sessionId) as ClaimRow[];
  }

  async getClaim(claimId: number): Promise<ClaimRow | null> {
    const row = this.cached(
      "claim-get",
      "SELECT * FROM claims WHERE id = ?",
    ).get(claimId) as ClaimRow | undefined;
    return row ?? null;
  }

  async listClaimLinksForSession(
    sessionId: string,
  ): Promise<readonly ClaimLinkRow[]> {
    return this.cached(
      "claim-link-list-session",
      `SELECT cl.*
       FROM claim_links cl
       JOIN claims c ON c.id = cl.src_id OR c.id = cl.dst_id
       WHERE c.session_id = ?
       GROUP BY cl.id
       ORDER BY cl.id`,
    ).all(sessionId) as ClaimLinkRow[];
  }

  async deleteClaimsForSession(sessionId: string): Promise<number> {
    const info = this.cached(
      "claim-delete-session",
      "DELETE FROM claims WHERE session_id = ?",
    ).run(sessionId);
    return Number(info.changes);
  }

  // ==================================================================
  // provider_stats
  // ==================================================================

  async listProviderStats(opts?: {
    limit?: number;
  }): Promise<readonly ProviderStatsRow[]> {
    const limit = opts?.limit ?? 100;
    return this.cached(
      "provider-stats-list",
      "SELECT * FROM provider_stats ORDER BY (wins + losses + abstains) DESC, provider ASC LIMIT ?",
    ).all(limit) as ProviderStatsRow[];
  }

  async getProviderStats(
    provider: string,
  ): Promise<ProviderStatsRow | null> {
    const row = this.cached(
      "provider-stats-get",
      "SELECT * FROM provider_stats WHERE provider = ?",
    ).get(provider) as ProviderStatsRow | undefined;
    return row ?? null;
  }

  async bumpProviderBallot(
    provider: string,
    ballot: "agree" | "disagree" | "abstain",
    at: number,
  ): Promise<void> {
    const column =
      ballot === "agree" ? "wins" : ballot === "disagree" ? "losses" : "abstains";
    this.db
      .prepare(
        `INSERT INTO provider_stats(provider, wins, losses, abstains, last_at)
         VALUES (?, 0, 0, 0, ?)
         ON CONFLICT(provider) DO NOTHING`,
      )
      .run(provider, at);
    this.db
      .prepare(
        `UPDATE provider_stats SET ${column} = ${column} + 1, last_at = ? WHERE provider = ?`,
      )
      .run(at, provider);
  }

  // ==================================================================
  // delegations
  // ==================================================================

  async insertDelegation(
    row: Parameters<Storage["insertDelegation"]>[0],
  ): Promise<void> {
    this.cached(
      "delegation-insert",
      `INSERT INTO delegations
         (session_id, requester, tool_call, via, accepted, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.session_id,
      row.requester,
      row.tool_call,
      row.via,
      row.accepted,
      row.created_at,
    );
  }

  async listDelegationsForSession(
    sessionId: string,
  ): Promise<readonly DelegationRow[]> {
    return this.cached(
      "delegation-list-session",
      "SELECT * FROM delegations WHERE session_id = ? ORDER BY id",
    ).all(sessionId) as DelegationRow[];
  }

  async countDelegationsByRequester(requester: string): Promise<number> {
    const r = this.cached(
      "delegation-count-req",
      "SELECT COUNT(*) AS n FROM delegations WHERE requester = ?",
    ).get(requester) as { n: number };
    return Number(r.n);
  }

  async countDelegationsBySession(sessionId: string): Promise<number> {
    const r = this.cached(
      "delegation-count-session",
      "SELECT COUNT(*) AS n FROM delegations WHERE session_id = ?",
    ).get(sessionId) as { n: number };
    return Number(r.n);
  }

  async listDelegationAggregatesByRequester(): Promise<
    readonly { requester: string; accepted: 0 | 1; count: number }[]
  > {
    const rows = this.cached(
      "delegation-agg-requester",
      "SELECT requester, accepted, COUNT(*) AS n FROM delegations " +
        "WHERE requester IS NOT NULL GROUP BY requester, accepted",
    ).all() as { requester: string; accepted: number; n: number }[];
    return rows.map((r) => ({
      requester: String(r.requester),
      accepted:  (r.accepted === 1 ? 1 : 0) as 0 | 1,
      count:     Number(r.n),
    }));
  }

  // ==================================================================
  // global counts (scoreboard / observability)
  // ==================================================================

  async countScoreboardTotals(): Promise<{
    sessions:    number;
    claims:      number;
    claim_links: number;
    delegations: number;
  }> {
    // Best-effort per-table count; missing tables degrade to 0 to
    // match Python's `try/except sqlite3.OperationalError` handling.
    const countOne = (table: string): number => {
      try {
        const r = this.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .get() as { n: number } | undefined;
        return r ? Number(r.n) : 0;
      } catch {
        return 0;
      }
    };
    return {
      sessions:    countOne("sessions"),
      claims:      countOne("claims"),
      claim_links: countOne("claim_links"),
      delegations: countOne("delegations"),
    };
  }

  // ==================================================================
  // session_memory
  // ==================================================================

  async insertSessionMemory(
    row: SessionMemoryInsert & { created_at: number },
  ): Promise<number> {
    if (!ALLOWED_MEMORY_KINDS.has(row.kind)) {
      throw new RangeError(`invalid session_memory kind: ${row.kind}`);
    }
    const info = this.cached(
      "memory-insert",
      `INSERT INTO session_memory
         (session_id, kind, content, source_tool, source_call_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.session_id,
      row.kind,
      row.content,
      row.source_tool ?? null,
      row.source_call_id ?? null,
      row.confidence ?? null,
      row.created_at,
    );
    return Number(info.lastInsertRowid);
  }

  async listSessionMemory(
    sessionId: string,
    opts?: ListSessionMemoryOpts,
  ): Promise<readonly SessionMemoryRow[]> {
    const where: string[] = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (!opts?.include_stale) where.push("stale_at IS NULL");
    if (opts?.kinds && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    const limit = opts?.limit ?? 50;
    params.push(limit);
    const sql = `SELECT * FROM session_memory WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params) as SessionMemoryRow[];
  }

  async markSessionMemoryStale(
    sessionId: string,
    at: number,
    opts?: MarkStaleOpts,
  ): Promise<number> {
    const where: string[] = ["session_id = ?", "stale_at IS NULL"];
    const params: unknown[] = [at, opts?.reason ?? "manual", sessionId];
    if (opts?.ids && opts.ids.length > 0) {
      where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
      params.push(...opts.ids);
    }
    if (opts?.kinds && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    const sql = `UPDATE session_memory SET stale_at = ?, stale_reason = ? WHERE ${where.join(" AND ")}`;
    const info = this.db.prepare(sql).run(...params);
    return Number(info.changes);
  }

  async clearSessionMemory(sessionId: string): Promise<number> {
    const info = this.cached(
      "memory-clear",
      "DELETE FROM session_memory WHERE session_id = ?",
    ).run(sessionId);
    return Number(info.changes);
  }

  // ==================================================================
  // fetch_egress
  // ==================================================================

  async recordFetchEgress(
    sessionId: string,
    host: string,
    bytes: number,
    at: number,
  ): Promise<void> {
    this.cached(
      "fetch-egress-upsert",
      `INSERT INTO fetch_egress (session_id, host, total_bytes, last_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, host) DO UPDATE SET
         total_bytes = total_bytes + excluded.total_bytes,
         last_at = excluded.last_at`,
    ).run(sessionId, host, bytes, at);
  }

  async getFetchEgressTotals(
    sessionId: string,
  ): Promise<{ total_bytes: number; unique_hosts: number }> {
    const r = this.cached(
      "fetch-egress-totals",
      "SELECT COALESCE(SUM(total_bytes), 0) AS total_bytes, COUNT(DISTINCT host) AS unique_hosts FROM fetch_egress WHERE session_id = ?",
    ).get(sessionId) as { total_bytes: number; unique_hosts: number };
    return {
      total_bytes: Number(r.total_bytes ?? 0),
      unique_hosts: Number(r.unique_hosts ?? 0),
    };
  }

  // ==================================================================
  // transcripts_fts — the encapsulated FTS5 surface.
  // ==================================================================

  async indexTranscript(row: {
    path: string;
    session_id: string | null;
    tool: string;
    ts: number;
    content: string;
  }): Promise<void> {
    this.cached(
      "fts-insert",
      `INSERT INTO transcripts_fts (session_id, tool, ts, path, content)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.session_id ?? "", row.tool, String(row.ts), row.path, row.content);
  }

  async recallSearch(
    query: string,
    k: number,
    opts?: RecallSearchOpts,
  ): Promise<readonly SearchHit[]> {
    const where: string[] = ["transcripts_fts MATCH ?"];
    const params: unknown[] = [query];
    if (opts?.session_id) {
      where.push("session_id = ?");
      params.push(opts.session_id);
    }
    if (opts?.tool) {
      where.push("tool = ?");
      params.push(opts.tool);
    }
    if (opts?.since_ms !== undefined) {
      where.push("CAST(ts AS INTEGER) >= ?");
      params.push(opts.since_ms);
    }
    params.push(k);
    const sql =
      `SELECT path, session_id, tool, ts, ` +
      `       snippet(transcripts_fts, -1, '[[', ']]', '...', 16) AS snippet, ` +
      `       bm25(transcripts_fts) AS rank ` +
      `FROM transcripts_fts WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      path: string;
      session_id: string | null;
      tool: string | null;
      ts: string | number;
      snippet: string;
      rank: number;
    }>;
    // Normalize bm25 (lower-is-better, unbounded) to a [0, 1] score
    // (higher-is-better). Simple monotone transform; sufficient for the
    // surfaces that consume score.
    return rows.map((r) => ({
      path: r.path,
      session_id: r.session_id ?? null,
      tool: r.tool ?? null,
      ts: Number(r.ts),
      snippet: r.snippet,
      score: 1 / (1 + Math.max(0, r.rank ?? 0)),
    }));
  }

  // ------------------------------------------------------------------
  // Prepared-statement cache. better-sqlite3 prepares statements lazily
  // and caches them internally, but the JS-side reference still costs
  // a hashmap lookup on every call. Keeping our own map by key lets
  // hot-path queries hit a single Map.get().
  // ------------------------------------------------------------------

  private cached(key: string, sql: string): Statement {
    let s = this.stmts.get(key);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(key, s);
    }
    return s;
  }
}

