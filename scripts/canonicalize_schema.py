#!/usr/bin/env python3
"""Canonical SQLite-schema string — Python mirror.

MUST stay byte-identical with `servers/typescript/src/adapters/storage/schema.ts`.
Reads PRAGMA output (not raw sqlite_master text) so two databases with
the same logical schema produce the same string regardless of how the
original CREATE statements were written.

Output shape (multi-line):
  table:<name>
    col:<cid>:<name>:<type>:<notnull>:<dflt>:<pk>
    ...
    idx:<name>:<unique>:<origin>:<partial>
      cols:<comma-joined-col-names>
    fk:<id>:<seq>:<to_table>:<from_col>:<to_col>:<on_update>:<on_delete>:<match>
  ...
  fts:<name>:<tokenize-spec>
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path


def canonical_schema(conn: sqlite3.Connection) -> str:
    lines: list[str] = []
    tables = _list_tables(conn)
    for table in tables:
        if _is_fts_shadow(table):
            continue
        if table.startswith("sqlite_"):
            continue
        if table == "schema_migrations":
            # TS-side migration tracking metadata; excluded from the
            # canonical schema so TS↔Py comparison only considers app
            # data tables.
            continue
        if _is_fts_virtual(conn, table):
            lines.append(f"fts:{table}:{_fts_tokenize(conn, table)}")
            continue
        lines.append(f"table:{table}")
        for c in _table_info(conn, table):
            lines.append(
                f"  col:{c['cid']}:{c['name']}:{c['type']}:{c['notnull']}:"
                f"{_format_default(c['dflt_value'])}:{c['pk']}"
            )
        for idx in _list_indexes(conn, table):
            lines.append(
                f"  idx:{idx['name']}:{idx['unique']}:{idx['origin']}:{idx['partial']}"
            )
            cols = _index_info(conn, idx["name"])
            lines.append(f"    cols:{','.join(cols)}")
        for fk in _list_fks(conn, table):
            lines.append(
                f"  fk:{fk['id']}:{fk['seq']}:{fk['table']}:{fk['from']}:"
                f"{fk['to']}:{fk['on_update']}:{fk['on_delete']}:{fk['match']}"
            )
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------
# Helpers — each returns a sorted, typed list.
# ----------------------------------------------------------------------
def _list_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


_FTS_SHADOW_RE = re.compile(r"_(data|idx|docsize|content|config)$")


def _is_fts_shadow(name: str) -> bool:
    return bool(_FTS_SHADOW_RE.search(name))


def _is_fts_virtual(conn: sqlite3.Connection, name: str) -> bool:
    r = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    if not r:
        return False
    sql = (r[0] or "").lower()
    return "using fts" in sql


_TOKENIZE_RE = re.compile(r"tokenize\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)


def _fts_tokenize(conn: sqlite3.Connection, name: str) -> str:
    r = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    if not r:
        return ""
    m = _TOKENIZE_RE.search(r[0] or "")
    return m.group(1) if m else ""


def _table_info(conn: sqlite3.Connection, name: str) -> list[dict]:
    rows = conn.execute(f"PRAGMA table_info('{name.replace(chr(39), chr(39)*2)}')").fetchall()
    items = [
        {
            "cid": int(r[0]),
            "name": str(r[1]),
            "type": str(r[2]),
            "notnull": int(r[3]),
            "dflt_value": r[4],
            "pk": int(r[5]),
        }
        for r in rows
    ]
    items.sort(key=lambda c: c["cid"])
    return items


def _format_default(v):  # type: ignore[no-untyped-def]
    if v is None:
        return "<null>"
    return str(v)


def _list_indexes(conn: sqlite3.Connection, table: str) -> list[dict]:
    rows = conn.execute(f"PRAGMA index_list('{table.replace(chr(39), chr(39)*2)}')").fetchall()
    items = [
        {
            "seq": int(r[0]),
            "name": str(r[1]),
            "unique": int(r[2]),
            "origin": str(r[3]),
            "partial": int(r[4]),
        }
        for r in rows
        if not str(r[1]).startswith("sqlite_autoindex_")
    ]
    items.sort(key=lambda i: i["name"])
    return items


def _index_info(conn: sqlite3.Connection, index_name: str) -> list[str]:
    rows = conn.execute(
        f"PRAGMA index_info('{index_name.replace(chr(39), chr(39)*2)}')"
    ).fetchall()
    items = [{"seqno": int(r[0]), "name": str(r[2])} for r in rows]
    items.sort(key=lambda i: i["seqno"])
    return [i["name"] for i in items]


def _list_fks(conn: sqlite3.Connection, table: str) -> list[dict]:
    rows = conn.execute(
        f"PRAGMA foreign_key_list('{table.replace(chr(39), chr(39)*2)}')"
    ).fetchall()
    items = [
        {
            "id": int(r[0]),
            "seq": int(r[1]),
            "table": str(r[2]),
            "from": str(r[3]),
            "to": str(r[4]),
            "on_update": str(r[5]),
            "on_delete": str(r[6]),
            "match": str(r[7]),
        }
        for r in rows
    ]
    items.sort(key=lambda f: (f["id"], f["seq"]))
    return items


# ----------------------------------------------------------------------
# CLI: `canonicalize_schema.py <path-to-db>` prints the canonical schema.
# ----------------------------------------------------------------------
def _cli(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: canonicalize_schema.py <db-path>\n")
        return 2
    db_path = Path(argv[1])
    if not db_path.exists():
        sys.stderr.write(f"no such file: {db_path}\n")
        return 2
    with sqlite3.connect(str(db_path)) as conn:
        sys.stdout.write(canonical_schema(conn))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
