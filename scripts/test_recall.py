#!/usr/bin/env python3
"""Tests for the FTS5-backed `recall` tool.

Covers:
  - bm25 ranking returns most-relevant transcripts first
  - session_id / tool / since_days filters compose with the FTS MATCH
  - canary nonces in a transcript are scrubbed before indexing
  - missing/blank query is rejected via the error taxonomy
  - invalid FTS5 syntax is reported with RECALL_QUERY_INVALID
  - write_transcript-disabled config bypasses indexing cleanly
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp())
    pricing = tmp / "pricing.json"
    pricing.write_text(json.dumps({
        "openai":    {"gpt-test": {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003, "completion_per_1k": 0.015, "cached_per_1k": 0.0003}},
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["log_transcripts"] = True
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None       # reprobe under the fresh DB
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    # FTS5 is required for this test — if the local SQLite was built without
    # it, fail loudly so we know the test environment is broken (rather than
    # silently passing a no-op).
    srv._db_init()
    assert srv._has_fts5(), "SQLite build lacks FTS5; rebuild Python's sqlite3"

    # ------------------------------------------------------------------
    # 1) write_transcript indexes; bm25 ranks the more-relevant one first
    # ------------------------------------------------------------------
    # Transcript A: low signal for our query.
    pA = srv.write_transcript("confer", {
        "tool":    "confer",
        "question": "what is the capital of france",
        "answers": [
            {"provider": "openai", "model": "gpt-test",
             "response": "Paris is the capital of France."},
        ],
        "session": {"session_id": "sess-cap"},
    })
    # Tiny sleep to keep timestamps strictly monotonic across stamps.
    time.sleep(0.01)
    # Transcript B: heavy signal on the query terms.
    pB = srv.write_transcript("coordinate", {
        "tool":    "coordinate",
        "topic":   "rate limit design for the public API",
        "synthesis_answer": {"provider": "anthropic", "model": "claude-test",
                              "response": "We recommend a global token-bucket "
                                          "rate limit at 100 rps with a burst "
                                          "of 20. Token-bucket is preferred."},
        "session": {"session_id": "sess-rl"},
    })
    time.sleep(0.01)
    # Transcript C: tangential.
    pC = srv.write_transcript("confer", {
        "tool":    "confer",
        "question": "should we cache HTTP responses",
        "answers": [
            {"provider": "openai", "model": "gpt-test",
             "response": "Yes, an LRU cache for hot GET responses helps."},
        ],
        "session": {"session_id": "sess-cache"},
    })
    assert pA and pB and pC

    res = srv.tool_recall({"query": "rate limit token bucket", "k": 5})
    assert res["tool"] == "recall", res
    assert res["count"] >= 1, res
    # B is the heaviest signal — must rank first.
    assert res["rows"][0]["session_id"] == "sess-rl", res["rows"]
    # bm25 score should be a finite number.
    assert isinstance(res["rows"][0]["score"], float)
    # Snippet should have the FTS5 hit markers.
    assert "[[" in res["rows"][0]["snippet"] and "]]" in res["rows"][0]["snippet"]

    # ------------------------------------------------------------------
    # 2) Filters compose: session_id
    # ------------------------------------------------------------------
    res = srv.tool_recall({"query": "rate", "session_id": "sess-rl"})
    assert all(r["session_id"] == "sess-rl" for r in res["rows"]), res["rows"]
    assert res["applied_filters"].get("session_id") == "sess-rl"

    # No matches under the wrong session_id.
    res = srv.tool_recall({"query": "rate", "session_id": "sess-cap"})
    assert res["count"] == 0, res

    # ------------------------------------------------------------------
    # 3) Filters compose: tool
    # ------------------------------------------------------------------
    res = srv.tool_recall({"query": "paris OR cache OR rate", "tool": "confer"})
    assert res["count"] >= 1, res
    assert all(r["tool"] == "confer" for r in res["rows"]), res["rows"]

    # ------------------------------------------------------------------
    # 4) since_days: a tiny window should exclude old rows
    # ------------------------------------------------------------------
    # All three rows were just inserted (ms ago), so since_days=1 includes all.
    res = srv.tool_recall({"query": "paris OR rate OR cache", "since_days": 1})
    assert res["count"] >= 2, res
    # Backdate one row, then query with a 1-day window: it should be excluded.
    with srv._db_conn() as conn:
        conn.execute(
            "UPDATE transcripts_fts SET ts = ? "
            "WHERE session_id = 'sess-cap'",
            (str(int((time.time() - 10 * 86400) * 1000)),),
        )
    res = srv.tool_recall({"query": "paris OR rate OR cache", "since_days": 1})
    sessions = {r["session_id"] for r in res["rows"]}
    assert "sess-cap" not in sessions, sessions

    # ------------------------------------------------------------------
    # 5) Canary nonces are scrubbed before indexing
    # ------------------------------------------------------------------
    canary = srv._mint_canary()
    srv.write_transcript("confer", {
        "tool":     "confer",
        "question": "leaky transcript",
        "answers":  [{"provider": "openai", "model": "gpt-test",
                       "response": f"some text with {canary} embedded"}],
        "session":  {"session_id": "sess-leaky"},
    })
    # Querying for the canary literal should not surface anything: FTS5
    # tokenization strips it from the canary regex during indexing.
    res = srv.tool_recall({"query": canary, "session_id": "sess-leaky"})
    assert res["count"] == 0, res
    # But the surrounding text is searchable.
    res = srv.tool_recall({"query": "leaky OR embedded", "session_id": "sess-leaky"})
    assert res["count"] >= 1, res
    assert canary not in res["rows"][0]["snippet"], res["rows"][0]["snippet"]

    # ------------------------------------------------------------------
    # 6) Error taxonomy: missing query
    # ------------------------------------------------------------------
    res = srv.tool_recall({"query": "  "})
    assert res.get("error_code") == "RECALL_MISSING_QUERY", res

    res = srv.tool_recall({})
    assert res.get("error_code") == "RECALL_MISSING_QUERY", res

    # ------------------------------------------------------------------
    # 7) Error taxonomy: invalid FTS5 syntax
    # ------------------------------------------------------------------
    # Bare AND with no left operand is rejected by FTS5.
    res = srv.tool_recall({"query": "AND"})
    assert res.get("error_code") == "RECALL_QUERY_INVALID", res

    # ------------------------------------------------------------------
    # 8) log_transcripts=false skips indexing entirely
    # ------------------------------------------------------------------
    srv.CFG["log_transcripts"] = False
    path = srv.write_transcript("confer", {
        "tool":     "confer",
        "question": "should not be indexed",
        "answers":  [],
        "session":  {"session_id": "sess-disabled"},
    })
    assert path is None
    res = srv.tool_recall({"query": "indexed", "session_id": "sess-disabled"})
    assert res["count"] == 0, res
    srv.CFG["log_transcripts"] = True

    # ------------------------------------------------------------------
    # 9) k clamping
    # ------------------------------------------------------------------
    res = srv.tool_recall({"query": "paris OR rate OR cache OR embedded", "k": 0})
    assert res["applied_filters"]["k"] == 1
    res = srv.tool_recall({"query": "paris OR rate OR cache OR embedded", "k": 1000})
    assert res["applied_filters"]["k"] == 50

    print("OK: test_recall")
    return 0


if __name__ == "__main__":
    sys.exit(main())
