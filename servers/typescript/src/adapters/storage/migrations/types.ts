// Migration types. A migration is an ordered list of SQL statements
// (DDL or DML). The runner applies them transactionally in id order
// and records the applied set in a `schema_migrations` tracking table.
//
// Migrations are PURE SQL strings stored as TS template literals so they
// bundle into the single-file output without filesystem I/O at runtime.

export interface Migration {
  /** Ascending-sortable identifier. Use `NNNN_short_description` shape;
   *  the runner sorts lexicographically. */
  readonly id: string;
  /** Short human description shown in logs. */
  readonly name: string;
  /** Forward statements. Each entry is one statement; the runner wraps
   *  them in a single transaction so partial failure rolls back. */
  readonly up: readonly string[];
}
