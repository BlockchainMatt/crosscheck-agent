#!/usr/bin/env python3
"""Offline test for the disk cache + session accounting.

Stubs out the provider HTTP layer so no API keys are required. Runs the same
question through `tool_confer` twice and asserts:

  1. Round 1: cache miss, response served from the stub.
  2. Round 2: cache hit (elapsed_ms == 0, cache_hit == True).
  3. Session counters accumulate across both calls.
  4. Budget summary is present and well-formed.

Exit 0 on success, non-zero on failure.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-test-"))
    try:
        # Override cache + session + transcript dirs to isolated tmp paths.
        import crosscheck_server as srv

        srv.CFG = dict(srv.CFG)
        srv.CFG["cache"] = {"enabled": True, "ttl_seconds": 3600, "max_entries": 100,
                            "dir": str(tmp / "cache")}
        srv.CFG["session_db"] = str(tmp / "sessions.sqlite3")
        srv._DB_INIT_DONE = False
        srv.CFG["log_transcripts"] = False
        srv.CFG["max_time_seconds"] = 5
        srv.CFG["token_cap"] = 1024

        # Inject a fake provider with a deterministic response.
        calls = {"n": 0}

        def fake_send(messages, max_tokens, temperature):
            calls["n"] += 1
            return f"echo-{messages[-1]['content']}"

        fake = srv.Provider(name="stub", send=fake_send, model="stub-1")
        srv.ALL_PROVIDERS = {"stub": fake}
        srv.CFG["providers"] = ["stub"]

        # Round 1: should be a cache miss; provider called once.
        r1 = srv.tool_confer({"question": "what is 2+2", "providers": ["stub"],
                              "session_id": "s1"})
        assert calls["n"] == 1,                    f"expected 1 provider call, got {calls['n']}"
        assert len(r1["answers"]) == 1,            f"expected 1 answer, got {len(r1['answers'])}"
        a1 = r1["answers"][0]
        assert a1["cache_hit"] is False,           f"round 1 should miss, got {a1!r}"
        assert a1["response"] == "echo-what is 2+2"
        assert "budget" in r1 and r1["budget"]["provider_calls"] == 1
        assert "session" in r1 and r1["session"]["calls"] == 1
        assert r1["session"]["cache_hits"] == 0

        # Round 2: same question — should hit cache; provider not called again.
        r2 = srv.tool_confer({"question": "what is 2+2", "providers": ["stub"],
                              "session_id": "s1"})
        assert calls["n"] == 1,                    f"cache should prevent 2nd call; got {calls['n']}"
        a2 = r2["answers"][0]
        assert a2["cache_hit"] is True,            f"round 2 should hit, got {a2!r}"
        assert a2["elapsed_ms"] == 0
        assert a2["response"] == "echo-what is 2+2"
        assert r2["budget"]["cache_hits"] == 1
        assert r2["session"]["calls"] == 2,        f"session.calls should be 2, got {r2['session']['calls']}"
        assert r2["session"]["cache_hits"] == 1,   f"session.cache_hits should be 1, got {r2['session']['cache_hits']}"

        # Different question shouldn't hit cache.
        r3 = srv.tool_confer({"question": "what is 3+3", "providers": ["stub"],
                              "session_id": "s1"})
        assert calls["n"] == 2,                    f"new prompt should call provider again, got {calls['n']}"
        assert r3["answers"][0]["cache_hit"] is False
        assert r3["session"]["calls"] == 3

        # Calls without session_id must not write session state.
        r4 = srv.tool_confer({"question": "what is 4+4", "providers": ["stub"]})
        assert "session" not in r4

        print(json.dumps({
            "rounds": [r1["session"], r2["session"], r3["session"]],
            "provider_calls_total": calls["n"],
            "cache_dir_files": len(list((tmp / "cache").rglob("*.json"))),
        }, indent=2))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
