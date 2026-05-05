#!/usr/bin/env python3
"""Offline tests for SQLite session memory + claim-list v0."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-db-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"] = str(tmp / "test.sqlite3")
        srv._DB_INIT_DONE = False

        # 1. Loading a non-existent session creates a row with zeroed counters.
        s = srv._session_load("alpha")
        assert s["session_id"] == "alpha"
        assert s["calls"] == 0 and s["wall_ms"] == 0 and s["cache_hits"] == 0
        assert s["started_at"] > 0

        # 2. Save/load round-trip.
        s["calls"] = 5
        s["wall_ms"] = 1234
        s["cache_hits"] = 2
        s["last_at"] = s["started_at"] + 10
        srv._session_save(s)
        s2 = srv._session_load("alpha")
        assert s2["calls"] == 5
        assert s2["wall_ms"] == 1234
        assert s2["cache_hits"] == 2
        assert s2["last_at"] == s["started_at"] + 10

        # 3. Adding claims and listing them.
        c1 = srv._claim_add("alpha", "PostgreSQL sequence keys are fine for high-write tables.",
                            provider="openai", confidence=0.85, kind="consensus",
                            citations=["https://www.postgresql.org/docs/current/sql-createsequence.html"])
        c2 = srv._claim_add("alpha", "uuid.v7() avoids hot pages on btree leaves.",
                            provider="anthropic", confidence=0.78, kind="support")
        c3 = srv._claim_add("alpha", "uuid.v7() doubles index size vs bigserial.",
                            provider="gemini", confidence=0.72, kind="dissent")
        assert isinstance(c1, int) and c1 > 0
        assert c2 > c1 and c3 > c2,                                 "ids should be monotonically increasing"

        claims = srv._session_claims("alpha")
        assert len(claims) == 3
        assert claims[0]["text"].startswith("PostgreSQL")
        assert claims[0]["citations"] == [
            "https://www.postgresql.org/docs/current/sql-createsequence.html"
        ]
        assert claims[1]["confidence"] == 0.78

        # 4. Linking claims (supports / attacks).
        srv._claim_link(c2, c1, "supports")
        srv._claim_link(c3, c1, "attacks")
        # Idempotent: duplicate link insert is a no-op.
        srv._claim_link(c3, c1, "attacks")

        links = srv._session_claim_links("alpha")
        assert len(links) == 2,                                     f"expected 2 links, got {len(links)}: {links!r}"
        kinds = sorted(l["kind"] for l in links)
        assert kinds == ["attacks", "supports"]
        assert {l["src_id"] for l in links} == {c2, c3}
        assert {l["dst_id"] for l in links} == {c1}

        # 5. Invalid claim/link kinds rejected.
        try:
            srv._claim_add("alpha", "bad", kind="garbage")
            return _fail("expected ValueError on bad claim kind")
        except ValueError:
            pass
        try:
            srv._claim_link(c1, c2, "garbage")
            return _fail("expected ValueError on bad link kind")
        except ValueError:
            pass

        # 6. session_id sanitization: weird characters get stripped, doesn't break.
        srv._session_load("../../etc/passwd")
        srv._claim_add("../../etc/passwd", "scoped to the safe id")
        sanitized_claims = srv._session_claims("../../etc/passwd")
        assert len(sanitized_claims) == 1

        # 7. Claims for a session must not bleed into another.
        srv._session_load("beta")
        srv._claim_add("beta", "different session claim")
        a = srv._session_claims("alpha")
        b = srv._session_claims("beta")
        assert len(a) == 3
        assert len(b) == 1

        # 8. Foreign-key cascade: deleting a session removes its claims/links.
        with srv._db_conn() as conn:
            conn.execute("DELETE FROM sessions WHERE session_id = ?", ("alpha",))
        post = srv._session_claims("alpha")
        post_links = srv._session_claim_links("alpha")
        assert post == [],                                          f"expected cascade delete, got {post!r}"
        assert post_links == [],                                    f"links should cascade too, got {post_links!r}"

        print("all SQLite session/claim tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
