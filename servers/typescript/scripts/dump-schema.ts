#!/usr/bin/env node
// dump-schema.ts — emit the canonical schema of a fresh TS-init'd
// SQLite DB to stdout. Used by the cross-language schema-parity test
// (scripts/test_ts_py_schema_parity.py) to compare against a Python-
// init'd DB's canonical schema.

import { openBetterSqliteStorage } from "../src/adapters/storage/better-sqlite3.js";

async function main(): Promise<void> {
  const path = process.argv[2] ?? ":memory:";
  const s = openBetterSqliteStorage({ path });
  await s.migrate();
  const out = await s.canonicalSchema();
  process.stdout.write(out);
  await s.close();
}

main().catch((err) => {
  process.stderr.write(`dump-schema: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
