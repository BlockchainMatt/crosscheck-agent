// 0001_init — initial schema. Mirrors the Python server's tables and
// indexes byte-for-byte after canonicalization (`scripts/canonicalize_schema.py`
// + `src/adapters/storage/schema.ts` produce identical strings).
//
// Every column declaration here MUST match
// `servers/python/crosscheck_server.py:_db_init` exactly. The
// Phase-1 schema-parity test enforces this; any drift fails CI before
// any tool can be ported on top of a divergent storage.
//
// Tables (in dependency order):
//   sessions
//   usage_log         (indexes: idx_usage_session, idx_usage_provider)
//   claims            (indexes: idx_claims_session) — FK to sessions
//   claim_links       (indexes: idx_links_src, idx_links_dst) — FK to claims
//   provider_stats
//   delegations       (indexes: idx_deleg_session, idx_deleg_req)
//   session_memory    (indexes: idx_session_memory_session, idx_session_memory_kind)
//   fetch_egress      (composite PK on session_id + host)
//   transcripts_fts   (FTS5 virtual table)
//
// The session usage-totals columns that the Python server adds via
// `_add_session_usage_columns` (PRAGMA-driven idempotent ALTER) are
// baked directly into the CREATE TABLE here; the runner reads PRAGMA
// table_info() to assert parity.

import type { Migration } from "./types.js";

export const m0001_init: Migration = {
  id: "0001_init",
  name: "initial schema (sessions, usage_log, claims, ...)",
  up: [
    // sessions — includes the totals columns that Python adds via ALTER.
    `CREATE TABLE IF NOT EXISTS sessions (
       session_id              TEXT PRIMARY KEY,
       started_at              INTEGER NOT NULL,
       last_at                 INTEGER,
       calls                   INTEGER NOT NULL DEFAULT 0,
       wall_ms                 INTEGER NOT NULL DEFAULT 0,
       cache_hits              INTEGER NOT NULL DEFAULT 0,
       total_prompt_tokens     INTEGER NOT NULL DEFAULT 0,
       total_completion_tokens INTEGER NOT NULL DEFAULT 0,
       total_cached_tokens     INTEGER NOT NULL DEFAULT 0,
       total_tokens            INTEGER NOT NULL DEFAULT 0,
       total_cost_usd          REAL    NOT NULL DEFAULT 0.0,
       total_cpu_ms            INTEGER NOT NULL DEFAULT 0
     )`,

    // usage_log — per-call ledger.
    `CREATE TABLE IF NOT EXISTS usage_log (
       id                INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id        TEXT NOT NULL,
       ts                INTEGER NOT NULL,
       tool              TEXT,
       purpose           TEXT NOT NULL,
       provider          TEXT NOT NULL,
       model             TEXT NOT NULL,
       prompt_tokens     INTEGER NOT NULL DEFAULT 0,
       completion_tokens INTEGER NOT NULL DEFAULT 0,
       cached_tokens     INTEGER NOT NULL DEFAULT 0,
       total_tokens      INTEGER NOT NULL DEFAULT 0,
       cost_usd          REAL    NOT NULL DEFAULT 0.0,
       estimated         INTEGER NOT NULL DEFAULT 0,
       wall_ms           INTEGER NOT NULL DEFAULT 0,
       cpu_ms            INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_session  ON usage_log(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider)`,

    // claims (FK to sessions, ON DELETE CASCADE).
    `CREATE TABLE IF NOT EXISTS claims (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
       text           TEXT NOT NULL,
       provider       TEXT,
       confidence     REAL,
       citations_json TEXT,
       kind           TEXT,
       created_at     INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session_id)`,

    // claim_links (FK to claims). Kind enum widened in Python's
    // _migrate_claim_links_check; mirrored here as the CHECK clause.
    `CREATE TABLE IF NOT EXISTS claim_links (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       src_id     INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
       dst_id     INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
       kind       TEXT    NOT NULL CHECK (kind IN ('supports','attacks','derives_from','merges_with')),
       created_at INTEGER NOT NULL,
       UNIQUE(src_id, dst_id, kind)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_links_src ON claim_links(src_id)`,
    `CREATE INDEX IF NOT EXISTS idx_links_dst ON claim_links(dst_id)`,

    // provider_stats — ballots accumulator for the smart router.
    `CREATE TABLE IF NOT EXISTS provider_stats (
       provider TEXT PRIMARY KEY,
       wins     INTEGER NOT NULL DEFAULT 0,
       losses   INTEGER NOT NULL DEFAULT 0,
       abstains INTEGER NOT NULL DEFAULT 0,
       last_at  INTEGER
     )`,

    // delegations — cross-model handshake ledger.
    `CREATE TABLE IF NOT EXISTS delegations (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT,
       requester  TEXT,
       tool_call  TEXT NOT NULL,
       via        TEXT NOT NULL,
       accepted   INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_deleg_session ON delegations(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_deleg_req     ON delegations(requester)`,

    // session_memory — facts / open_questions / decisions ledger.
    `CREATE TABLE IF NOT EXISTS session_memory (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id     TEXT    NOT NULL,
       kind           TEXT    NOT NULL CHECK (kind IN ('fact','open_question','decision')),
       content        TEXT    NOT NULL,
       source_tool    TEXT,
       source_call_id TEXT,
       confidence     REAL,
       created_at     INTEGER NOT NULL,
       stale_at       INTEGER,
       stale_reason   TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_session_memory_session ON session_memory(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_session_memory_kind    ON session_memory(kind)`,

    // fetch_egress — per-session per-host byte ledger.
    `CREATE TABLE IF NOT EXISTS fetch_egress (
       session_id  TEXT NOT NULL,
       host        TEXT NOT NULL,
       total_bytes INTEGER NOT NULL DEFAULT 0,
       last_at     INTEGER NOT NULL,
       PRIMARY KEY (session_id, host)
     )`,

    // transcripts_fts — FTS5 virtual table for the recall tool. Python uses
    // `tokenize='unicode61 remove_diacritics 2'`; mirrored exactly.
    `CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
       session_id, tool, ts UNINDEXED, path UNINDEXED, content,
       tokenize='unicode61 remove_diacritics 2'
     )`,
  ],
};
