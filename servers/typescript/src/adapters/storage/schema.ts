// Canonical schema string — derived from PRAGMA reads, NOT raw
// sqlite_master text. Two SQLite databases with the same logical
// schema produce the same canonical string regardless of how the
// CREATE statements were originally written (whitespace, IF NOT
// EXISTS, declaration order, etc.).
//
// Must produce byte-identical output with `scripts/canonicalize_schema.py`.
// Update both files in lockstep.
//
// Output shape (multi-line):
//   table:<name>
//     col:<cid>:<name>:<type>:<notnull>:<dflt>:<pk>
//     ...
//     idx:<name>:<unique>:<origin>:<partial>
//       <indexed-col-list>
//     fk:<id>:<seq>:<to_table>:<from_col>:<to_col>:<on_update>:<on_delete>:<match>
//   table:<next>
//   ...
//   fts:<name>:<tokenize-spec>
//
// Tables are sorted by name. Within a table, columns are sorted by
// PRAGMA cid (== declaration order, matching Python). Indexes within
// a table are sorted by name; foreign keys by (id, seq).

// Generic row shape — accepts better-sqlite3's mixed-type rows. We narrow
// at the leaves where needed.
type Row = Record<string, unknown>;

/** A reader interface so this module isn't coupled to better-sqlite3 —
 *  the wa-sqlite adapter will pass a similar reader. */
export interface SchemaReader {
  /** Run a `PRAGMA <name>(<arg?>)` and return rows. */
  pragma(name: string, arg?: string): readonly Row[];
  /** Run any SELECT used to enumerate names. */
  list(sql: string): readonly Row[];
}

export function canonicalSchema(reader: SchemaReader): string {
  const tables = listTables(reader);
  const lines: string[] = [];

  for (const table of tables) {
    if (isFtsShadowTable(table)) continue;     // skip FTS5 shadow content tables
    if (isInternal(table)) continue;            // sqlite_*
    if (table === "schema_migrations") continue; // TS-side migration tracking metadata

    if (isFtsVirtualTable(reader, table)) {
      lines.push(`fts:${table}:${ftsTokenize(reader, table)}`);
      continue;
    }

    lines.push(`table:${table}`);
    for (const c of tableInfo(reader, table)) {
      lines.push(
        `  col:${c.cid}:${c.name}:${c.type}:${c.notnull}:${formatDefault(c.dflt_value)}:${c.pk}`,
      );
    }
    for (const idx of listIndexes(reader, table)) {
      lines.push(
        `  idx:${idx.name}:${idx.unique}:${idx.origin}:${idx.partial}`,
      );
      const cols = indexInfo(reader, idx.name);
      lines.push(`    cols:${cols.map((c) => c.name).join(",")}`);
    }
    for (const fk of listFks(reader, table)) {
      lines.push(
        `  fk:${fk.id}:${fk.seq}:${fk.table}:${fk.from}:${fk.to}:${fk.on_update}:${fk.on_delete}:${fk.match}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

// ----------------------------------------------------------------------
// Helpers — each returns a sorted, typed list.
// ----------------------------------------------------------------------

function listTables(reader: SchemaReader): string[] {
  const rows = reader.list(
    "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => String(r["name"]));
}

function isInternal(name: string): boolean {
  return name.startsWith("sqlite_");
}

function isFtsShadowTable(name: string): boolean {
  // FTS5 creates several shadow tables per virtual table: <name>_data,
  // _idx, _docsize, _content, _config. They're implementation detail.
  return /_(data|idx|docsize|content|config)$/.test(name);
}

function isFtsVirtualTable(reader: SchemaReader, name: string): boolean {
  const r = reader.list(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${name.replace(/'/g, "''")}'`,
  );
  if (r.length === 0) return false;
  const sql = String(r[0]?.["sql"] ?? "").toLowerCase();
  return sql.includes("using fts");
}

function ftsTokenize(reader: SchemaReader, name: string): string {
  const r = reader.list(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${name.replace(/'/g, "''")}'`,
  );
  if (r.length === 0) return "";
  const sql = String(r[0]?.["sql"] ?? "");
  const m = sql.match(/tokenize\s*=\s*['"]([^'"]+)['"]/i);
  return m?.[1] ?? "";
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function tableInfo(reader: SchemaReader, name: string): ColumnRow[] {
  // PRAGMA table_info returns rows in column-declaration order; sort by
  // cid to make sure even if a future SQLite reorders them, we don't.
  const rows = reader.pragma("table_info", name);
  return rows
    .map(
      (r): ColumnRow => ({
        cid: Number(r["cid"] ?? 0),
        name: String(r["name"] ?? ""),
        type: String(r["type"] ?? ""),
        notnull: Number(r["notnull"] ?? 0),
        dflt_value: r["dflt_value"],
        pk: Number(r["pk"] ?? 0),
      }),
    )
    .sort((a, b) => a.cid - b.cid);
}

function formatDefault(v: unknown): string {
  // SQLite stores defaults as the literal text from the CREATE TABLE,
  // including quoting. The Python canonicalizer renders these the same
  // way, so we just stringify with explicit null marker.
  if (v === null || v === undefined) return "<null>";
  return String(v);
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

function listIndexes(reader: SchemaReader, table: string): IndexListRow[] {
  const rows = reader.pragma("index_list", table);
  return rows
    .map(
      (r): IndexListRow => ({
        seq: Number(r["seq"] ?? 0),
        name: String(r["name"] ?? ""),
        unique: Number(r["unique"] ?? 0),
        origin: String(r["origin"] ?? ""),
        partial: Number(r["partial"] ?? 0),
      }),
    )
    .filter((r) => !r.name.startsWith("sqlite_autoindex_"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface IndexInfoRow {
  seqno: number;
  name: string;
}

function indexInfo(reader: SchemaReader, indexName: string): IndexInfoRow[] {
  const rows = reader.pragma("index_info", indexName);
  return rows
    .map(
      (r): IndexInfoRow => ({
        seqno: Number(r["seqno"] ?? 0),
        name: String(r["name"] ?? ""),
      }),
    )
    .sort((a, b) => a.seqno - b.seqno);
}

interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

function listFks(reader: SchemaReader, table: string): FkRow[] {
  const rows = reader.pragma("foreign_key_list", table);
  return rows
    .map(
      (r): FkRow => ({
        id: Number(r["id"] ?? 0),
        seq: Number(r["seq"] ?? 0),
        table: String(r["table"] ?? ""),
        from: String(r["from"] ?? ""),
        to: String(r["to"] ?? ""),
        on_update: String(r["on_update"] ?? ""),
        on_delete: String(r["on_delete"] ?? ""),
        match: String(r["match"] ?? ""),
      }),
    )
    .sort((a, b) => a.id - b.id || a.seq - b.seq);
}
