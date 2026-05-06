#!/usr/bin/env python3
"""Offline tests for the fetch tool, claim-DAG link kinds, and dedupe.

The fetch tests use a local http.server bound to 127.0.0.1 — no
internet access required.
"""

from __future__ import annotations

import http.server
import json
import shutil
import socketserver
import sys
import tempfile
import threading
import time
from pathlib import Path


def _start_local_server(content: bytes, content_type: str = "text/plain"):
    """Start a one-shot local HTTP server returning `content` on any path."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # type: ignore[override]
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        def log_message(self, *_a, **_kw):  # silence
            pass

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    return httpd, port


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-fetch-"))
    httpd, port = _start_local_server(b"hello, evidence world", "text/plain; charset=utf-8")
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"] = str(tmp / "sessions.sqlite3")
        srv._DB_INIT_DONE = False

        # ---- fetch: allowlist denies by default ----
        srv.CFG["fetch"] = {"enabled": True, "url_allowlist": [],
                            "evidence_dir": str(tmp / "evidence"),
                            "max_bytes": 1024 * 1024, "timeout_s": 5}
        r = srv.tool_fetch({"url": f"http://127.0.0.1:{port}/x"})
        assert r["accepted"] is False
        assert "url_allowlist is empty" in r["reason"]

        # ---- fetch: scheme check ----
        srv.CFG["fetch"]["url_allowlist"] = [f"http://127.0.0.1:{port}/"]
        r = srv.tool_fetch({"url": "ftp://example.com/x"})
        assert r["accepted"] is False
        assert "schemes" in r["reason"]

        # ---- fetch: allowlist hit + sha256 snapshot ----
        url = f"http://127.0.0.1:{port}/page"
        r = srv.tool_fetch({"url": url})
        assert r["accepted"] is True,                               f"got {r!r}"
        assert r["cached"] is False
        assert r["bytes"] == len(b"hello, evidence world")
        assert len(r["sha256"]) == 64
        snapshot_path = Path(r["path"]) if Path(r["path"]).is_absolute() else (here / r["path"])
        assert snapshot_path.exists()
        assert snapshot_path.read_bytes() == b"hello, evidence world"

        # ---- fetch: cached on second call ----
        r2 = srv.tool_fetch({"url": url})
        assert r2["accepted"] is True
        assert r2["cached"] is True
        assert r2["sha256"] == r["sha256"]

        # ---- fetch: force_refresh re-fetches ----
        r3 = srv.tool_fetch({"url": url, "force_refresh": True})
        assert r3["accepted"] is True
        assert r3["cached"] is False
        assert r3["sha256"] == r["sha256"]  # same content

        # ---- fetch: max_bytes enforced ----
        srv.CFG["fetch"]["max_bytes"] = 5  # smaller than 'hello, evidence world'
        srv.CFG["fetch"]["url_allowlist"] = [f"http://127.0.0.1:{port}/big"]
        r = srv.tool_fetch({"url": f"http://127.0.0.1:{port}/big"})
        assert r["accepted"] is False
        assert "max_bytes" in r["reason"]
        srv.CFG["fetch"]["max_bytes"] = 1024 * 1024

        # ---- fetch: enabled=false short-circuits ----
        srv.CFG["fetch"]["enabled"] = False
        r = srv.tool_fetch({"url": url})
        assert r["accepted"] is False and "disabled" in r["reason"]
        srv.CFG["fetch"]["enabled"] = True

        # ---- fetch: not in allowlist ----
        srv.CFG["fetch"]["url_allowlist"] = [f"http://127.0.0.1:{port}/page"]
        r = srv.tool_fetch({"url": f"http://example.com/other"})
        assert r["accepted"] is False
        assert "not covered by fetch.url_allowlist" in r["reason"]

        # ---- claim DAG: dedupe by token Jaccard ----
        srv._DB_INIT_DONE = False  # fresh db init for clarity (path same)
        c1 = srv._claim_add("dag-1", "Use bigserial primary keys for high-write Postgres tables.",
                            kind="consensus", dedupe=False)
        # Near-duplicate phrasing -> should be linked merges_with at insert time
        c2 = srv._claim_add("dag-1",
                            "Use bigserial primary keys for high write Postgres tables",
                            kind="support")
        # Unrelated claim -> no merge link
        c3 = srv._claim_add("dag-1", "uuid.v7 helps with multi-region writes.", kind="support")

        links = srv._session_claim_links("dag-1")
        merge_links = [l for l in links if l["kind"] == "merges_with"]
        assert len(merge_links) == 1,                               f"expected 1 merge_with link, got {merge_links}"
        assert merge_links[0]["src_id"] == c2 and merge_links[0]["dst_id"] == c1

        # c3 should not merge with anything.
        assert not any(l["src_id"] == c3 and l["kind"] == "merges_with" for l in links)

        # ---- claim DAG: explicit derives_from link ----
        srv._claim_link(c2, c1, "derives_from")
        links = srv._session_claim_links("dag-1")
        assert any(l["kind"] == "derives_from" and l["src_id"] == c2 and l["dst_id"] == c1
                   for l in links)

        # ---- claim DAG: invalid link kind rejected ----
        try:
            srv._claim_link(c1, c2, "garbage")
            print("FAIL: bad link kind accepted", file=sys.stderr)
            return 1
        except ValueError:
            pass

        # ---- claim DAG: dedupe doesn't fire below threshold ----
        c4 = srv._claim_add("dag-2", "Cache aside is the right call here.", kind="consensus")
        c5 = srv._claim_add("dag-2", "Write-through is simpler operationally.", kind="dissent")
        links2 = srv._session_claim_links("dag-2")
        assert not any(l["kind"] == "merges_with" for l in links2)

        # ---- migration: an old-form claim_links table widens at startup ----
        srv._DB_INIT_DONE = False
        old_db = tmp / "old.sqlite3"
        import sqlite3 as _sqlite
        with _sqlite.connect(str(old_db)) as conn:
            conn.executescript("""
                CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
                  last_at INTEGER, calls INTEGER NOT NULL DEFAULT 0,
                  wall_ms INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE claims (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  session_id TEXT NOT NULL REFERENCES sessions(session_id),
                  text TEXT NOT NULL, provider TEXT, confidence REAL,
                  citations_json TEXT, kind TEXT, created_at INTEGER NOT NULL);
                CREATE TABLE claim_links (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  src_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
                  dst_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
                  kind TEXT NOT NULL CHECK (kind IN ('supports','attacks')),
                  created_at INTEGER NOT NULL,
                  UNIQUE(src_id, dst_id, kind));
                INSERT INTO sessions(session_id, started_at) VALUES ('legacy', 1);
                INSERT INTO claims(session_id, text, kind, created_at)
                  VALUES ('legacy','old1','consensus',1),('legacy','old2','support',1);
                INSERT INTO claim_links(src_id, dst_id, kind, created_at)
                  VALUES (2, 1, 'supports', 1);
            """)
        srv.CFG["session_db"] = str(old_db)
        srv._DB_INIT_DONE = False
        # Now an insert with the new kind must succeed thanks to migration.
        srv._claim_link(2, 1, "derives_from")
        srv._claim_link(2, 1, "merges_with")
        with _sqlite.connect(str(old_db)) as conn:
            conn.row_factory = _sqlite.Row
            kinds = sorted(r["kind"] for r in conn.execute("SELECT kind FROM claim_links"))
        assert kinds == ["derives_from", "merges_with", "supports"], f"got {kinds}"

        print("all fetch + DAG tests passed")
        return 0
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
