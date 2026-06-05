// Storage adapter interface — the highest-risk contract in the entire
// TypeScript port. The 4-way confer + 3-way debate (session
// `ts-port-design-1`) unanimously flagged this as the riskiest decision:
// any leak of raw SQL or FTS5-specific syntax through the interface
// kills the browser port later.
//
// Design rules (locked):
//   1. Typed method-per-query — ~30 methods grouped by domain. NO generic
//      `query<T>(sql, params)` primitive in the app's call path.
//   2. `recallSearch()` encapsulates FTS5 MATCH / bm25 / snippet — callers
//      never see the SQLite-specific syntax.
//   3. Async-only. The better-sqlite3 adapter wraps its sync work in
//      Promise.resolve(); the wa-sqlite/OPFS adapter is natively async.
//   4. Transactions ONLY via `txn(fn)` callback. `Txn` mirrors `Storage`'s
//      method set so callers compose freely without thinking about
//      BEGIN/COMMIT/ROLLBACK.
//   5. Schema migrations: shipped ordered list (`adapters/storage/migrations/*`),
//      tracked via a `schema_migrations` table created at init.
//   6. Adapters own prepared-statement caching, PRAGMA/WAL setup, and (for
//      OPFS) a single-writer queue.
//
// The `raw()` escape hatch is intentional but namespaced — it lives on
// `UnsafeStorage`, accessible only via `storage.unsafe()`. App code must
// not import the unsafe surface; it exists for migrations + debug only.

// ----------------------------------------------------------------------
// Row types — mirror the Python schema 1:1 so query results round-trip
// across the bridge. Field names match the column names in the SQL.
// ----------------------------------------------------------------------

/** sessions row. */
export interface SessionRow {
  session_id: string;
  started_at: number;
  last_at: number | null;
  calls: number;
  wall_ms: number;
  cache_hits: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_cpu_ms: number;
}

/** usage_log row. */
export interface UsageLogRow {
  id: number;
  session_id: string;
  ts: number;
  tool: string | null;
  purpose: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: number;
  wall_ms: number;
  cpu_ms: number;
}

/** Insert shape for usage_log (id is auto-assigned, defaults filled by SQL). */
export interface UsageLogInsert {
  session_id: string;
  ts: number;
  tool: string | null;
  purpose: string;
  provider: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  estimated?: number;
  wall_ms?: number;
  cpu_ms?: number;
}

/** claims row. citations_json is the raw JSON string as stored. */
export interface ClaimRow {
  id: number;
  session_id: string;
  text: string;
  provider: string | null;
  confidence: number | null;
  citations_json: string | null;
  kind: string | null;
  created_at: number;
}

export interface ClaimInsert {
  session_id: string;
  text: string;
  provider?: string | null;
  confidence?: number | null;
  citations?: readonly string[] | null;
  kind?: string | null;
}

/** claim_links row. kind is constrained: supports | attacks | derives_from | merges_with. */
export type ClaimLinkKind = "supports" | "attacks" | "derives_from" | "merges_with";

export interface ClaimLinkRow {
  id: number;
  src_id: number;
  dst_id: number;
  kind: ClaimLinkKind;
  created_at: number;
}

/** provider_stats row. */
export interface ProviderStatsRow {
  provider: string;
  wins: number;
  losses: number;
  abstains: number;
  last_at: number | null;
}

/** delegations row. */
export interface DelegationRow {
  id: number;
  session_id: string | null;
  requester: string | null;
  tool_call: string;
  via: string;
  accepted: number;
  created_at: number;
}

/** session_memory row. kind is constrained: fact | open_question | decision. */
export type SessionMemoryKind = "fact" | "open_question" | "decision";

export interface SessionMemoryRow {
  id: number;
  session_id: string;
  kind: SessionMemoryKind;
  content: string;
  source_tool: string | null;
  source_call_id: string | null;
  confidence: number | null;
  created_at: number;
  stale_at: number | null;
  stale_reason: string | null;
}

export interface SessionMemoryInsert {
  session_id: string;
  kind: SessionMemoryKind;
  content: string;
  source_tool?: string | null;
  source_call_id?: string | null;
  confidence?: number | null;
}

/** fetch_egress row (composite PK on session_id+host). */
export interface FetchEgressRow {
  session_id: string;
  host: string;
  total_bytes: number;
  last_at: number;
}

/** A single FTS5 search hit. The adapter handles snippet/highlight
 *  internally; the caller never sees raw bm25 scores either — `score`
 *  is normalized to [0, 1] where higher = better match. */
export interface SearchHit {
  path: string;
  session_id: string | null;
  tool: string | null;
  ts: number;
  snippet: string;
  /** Normalized [0,1]; higher is better. Adapters convert bm25 (lower-is-
   *  better) to this normalized form internally. */
  score: number;
}

export interface RecallSearchOpts {
  /** Match within a single session. */
  session_id?: string;
  /** Match within a single tool. */
  tool?: string;
  /** Only matches with ts >= sinceMs. */
  since_ms?: number;
}

// ----------------------------------------------------------------------
// Filter / list options — small wrappers around the common kinds-and-limit
// shape so adapters can implement them as prepared statements without
// dynamic SQL construction.
// ----------------------------------------------------------------------

export interface ListSessionMemoryOpts {
  kinds?: readonly SessionMemoryKind[];
  include_stale?: boolean;
  limit?: number;
}

export interface MarkStaleOpts {
  ids?: readonly number[];
  kinds?: readonly SessionMemoryKind[];
  reason?: string;
}

// ----------------------------------------------------------------------
// Read surface — every getter. Mirrors the Python query shapes 1:1 so
// the bridge can route either way without translation.
// ----------------------------------------------------------------------

export interface StorageRead {
  // sessions
  getSession(sessionId: string): Promise<SessionRow | null>;
  listSessions(opts?: { limit?: number }): Promise<readonly SessionRow[]>;

  // usage_log
  listUsageForSession(
    sessionId: string,
    opts?: {
      only_purpose?: readonly string[];
      only_provider?: readonly string[];
      limit?: number;
    },
  ): Promise<readonly UsageLogRow[]>;
  listUsageGroupedByPurpose(
    sessionId: string,
  ): Promise<
    readonly {
      purpose: string;
      calls: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_usd: number;
      wall_ms: number;
      cpu_ms: number;
    }[]
  >;
  listUsageGroupedByProvider(
    purpose?: string,
  ): Promise<
    readonly {
      provider: string;
      calls: number;
      total_tokens: number;
      cost_usd: number;
      errors: number;
    }[]
  >;

  // claims
  listClaimsForSession(sessionId: string): Promise<readonly ClaimRow[]>;
  getClaim(claimId: number): Promise<ClaimRow | null>;
  listClaimLinksForSession(sessionId: string): Promise<readonly ClaimLinkRow[]>;

  // provider_stats
  listProviderStats(opts?: {
    limit?: number;
  }): Promise<readonly ProviderStatsRow[]>;
  getProviderStats(provider: string): Promise<ProviderStatsRow | null>;

  // delegations
  listDelegationsForSession(sessionId: string): Promise<readonly DelegationRow[]>;
  countDelegationsByRequester(
    requester: string,
  ): Promise<number>;
  countDelegationsBySession(sessionId: string): Promise<number>;

  // session_memory
  listSessionMemory(
    sessionId: string,
    opts?: ListSessionMemoryOpts,
  ): Promise<readonly SessionMemoryRow[]>;

  // fetch_egress
  getFetchEgressTotals(
    sessionId: string,
  ): Promise<{ total_bytes: number; unique_hosts: number }>;

  // transcripts_fts (encapsulated FTS5)
  recallSearch(
    query: string,
    k: number,
    opts?: RecallSearchOpts,
  ): Promise<readonly SearchHit[]>;
}

// ----------------------------------------------------------------------
// Write surface — every mutator.
// ----------------------------------------------------------------------

export interface StorageWrite {
  // sessions
  upsertSession(row: SessionRow): Promise<void>;
  accumulateSessionTotals(
    sessionId: string,
    delta: {
      calls?: number;
      wall_ms?: number;
      cache_hits?: number;
      total_prompt_tokens?: number;
      total_completion_tokens?: number;
      total_cached_tokens?: number;
      total_tokens?: number;
      total_cost_usd?: number;
      total_cpu_ms?: number;
      last_at?: number;
    },
  ): Promise<void>;

  // usage_log
  insertUsage(rows: readonly UsageLogInsert[]): Promise<void>;

  // claims
  insertClaim(claim: ClaimInsert): Promise<number>;
  insertClaimLink(
    srcId: number,
    dstId: number,
    kind: ClaimLinkKind,
  ): Promise<void>;
  deleteClaimsForSession(sessionId: string): Promise<number>;

  // provider_stats
  bumpProviderBallot(
    provider: string,
    ballot: "agree" | "disagree" | "abstain",
    at: number,
  ): Promise<void>;

  // delegations
  insertDelegation(row: {
    session_id: string | null;
    requester: string | null;
    tool_call: string;
    via: string;
    accepted: 0 | 1;
    created_at: number;
  }): Promise<void>;

  // session_memory
  insertSessionMemory(row: SessionMemoryInsert & { created_at: number }): Promise<number>;
  markSessionMemoryStale(
    sessionId: string,
    at: number,
    opts?: MarkStaleOpts,
  ): Promise<number>;
  clearSessionMemory(sessionId: string): Promise<number>;

  // fetch_egress
  recordFetchEgress(
    sessionId: string,
    host: string,
    bytes: number,
    at: number,
  ): Promise<void>;

  // transcripts_fts
  indexTranscript(row: {
    path: string;
    session_id: string | null;
    tool: string;
    ts: number;
    content: string;
  }): Promise<void>;
}

// ----------------------------------------------------------------------
// Txn — the same surface as Storage, but every method runs inside an
// open transaction. Callers obtain a Txn via `storage.txn(fn)`.
// ----------------------------------------------------------------------

export type Txn = StorageRead & StorageWrite;

// ----------------------------------------------------------------------
// Unsafe escape hatch — migrations + debug only. Not on the app's path.
// ----------------------------------------------------------------------

export interface UnsafeStorage {
  /** Execute arbitrary DDL/DML. Returns the rows-changed count.
   *  DO NOT call from app code. */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Run a query returning rows. Returns each row as a generic record. */
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

// ----------------------------------------------------------------------
// Storage — the top-level interface adapters implement.
// ----------------------------------------------------------------------

export interface Storage extends StorageRead, StorageWrite {
  /** Open a transaction. The callback receives a Txn with the same
   *  surface as Storage; nesting reuses the outer transaction via
   *  SAVEPOINTs. Throws bubble out as ROLLBACK. */
  txn<T>(fn: (txn: Txn) => Promise<T>): Promise<T>;

  /** Migration runner — applies any pending migrations in order. Idempotent;
   *  re-running is a no-op when nothing's pending. */
  migrate(): Promise<{ applied: readonly string[] }>;

  /** PRAGMA-derived canonical schema string. Used by the parity gate to
   *  assert a TS-init'd DB has the same schema as a Python-init'd one. */
  canonicalSchema(): Promise<string>;

  /** Access the unsafe surface. Migrations only. */
  unsafe(): UnsafeStorage;

  /** Close any underlying handles. */
  close(): Promise<void>;
}
