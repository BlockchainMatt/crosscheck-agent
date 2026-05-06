#!/usr/bin/env python3
"""Offline tests for the delegate tool (cross-model handshake + quota)."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-deleg-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]      = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]      = str(tmp / "events.ndjson")
        srv.CFG["cache"]           = {"enabled": False}
        srv.CFG["max_time_seconds"] = 5
        srv.CFG["token_cap"]       = 1024
        srv.CFG["provider_allowlist"] = None
        srv.CFG["delegation"]      = {"max_per_session": 3, "max_per_requester": 5}
        srv._DB_INIT_DONE = False

        # Stub two providers; track which one got called.
        calls = {"alpha": 0, "beta": 0}
        def make_send(name):
            def s(messages, max_tokens, temperature):
                calls[name] += 1
                return (f"answer-from-{name}", 1)
            return s
        srv.ALL_PROVIDERS = {
            "alpha": srv.Provider(name="alpha", send=make_send("alpha"), model="m"),
            "beta":  srv.Provider(name="beta",  send=make_send("beta"),  model="m"),
        }
        srv.CFG["providers"] = ["alpha", "beta"]

        # 1. Happy path: confer delegated to beta only.
        r = srv.tool_delegate({
            "tool_call": "confer",
            "via": "beta",
            "args": {"question": "what is 2+2?"},
            "session_id": "deleg-1",
            "requested_by": "alpha",
        })
        assert r["accepted"] is True,                  f"got {r!r}"
        assert r["via"] == "beta"
        assert r["tool_call"] == "confer"
        assert calls["alpha"] == 0,                    f"alpha should not be called via delegate to beta; got {calls}"
        assert calls["beta"] == 1
        assert r["quota"]["session_used"] == 1
        assert r["quota"]["session_remaining"] == 2
        assert r["quota"]["requester_used"] == 1
        # Inner result is the confer payload.
        assert r["result"]["tool"] == "confer"
        assert r["result"]["answers"][0]["provider"] == "beta"
        assert r["result"]["answers"][0]["response"] == "answer-from-beta"

        # 2. Caller-supplied `providers` is overridden to [via].
        calls["alpha"] = calls["beta"] = 0
        r = srv.tool_delegate({
            "tool_call": "confer",
            "via": "alpha",
            "args": {"question": "what is 3+3?", "providers": ["beta"]},  # should be ignored
            "session_id": "deleg-1",
        })
        assert r["accepted"] is True
        assert calls["alpha"] == 1
        assert calls["beta"] == 0,                     "providers override failed"

        # 3. Unknown tool rejected.
        r = srv.tool_delegate({"tool_call": "debate", "via": "alpha", "args": {}})
        assert r["accepted"] is False
        assert "not delegable" in r["reason"]

        # 4. Unknown provider rejected.
        r = srv.tool_delegate({"tool_call": "confer", "via": "ghost",
                               "args": {"question": "x"}})
        assert r["accepted"] is False
        assert "not configured" in r["reason"]

        # 5. Allowlist blocks delegation.
        srv.CFG["provider_allowlist"] = ["alpha"]
        r = srv.tool_delegate({"tool_call": "confer", "via": "beta",
                               "args": {"question": "x"}, "session_id": "deleg-1"})
        assert r["accepted"] is False
        assert "blocked by provider_allowlist" in r["reason"]
        srv.CFG["provider_allowlist"] = None

        # 6. Per-session quota: 3 max, we already have 2 accepted under deleg-1.
        # The next accepted call hits the cap; the one after that is refused.
        r = srv.tool_delegate({"tool_call": "confer", "via": "beta",
                               "args": {"question": "third"}, "session_id": "deleg-1"})
        assert r["accepted"] is True
        assert r["quota"]["session_used"] == 3
        assert r["quota"]["session_remaining"] == 0
        r = srv.tool_delegate({"tool_call": "confer", "via": "beta",
                               "args": {"question": "fourth"}, "session_id": "deleg-1"})
        assert r["accepted"] is False
        assert r["reason"] == "quota_exhausted_for_session"

        # 7. Per-requester quota: separate session bypasses session cap; requester cap kicks in.
        # alpha already has 1 requester counter from step 1. Bring it up.
        for i in range(4):
            srv.tool_delegate({"tool_call": "confer", "via": "beta",
                               "args": {"question": f"q{i}"},
                               "session_id": f"sess-r-{i}", "requested_by": "alpha"})
        r = srv.tool_delegate({"tool_call": "confer", "via": "beta",
                               "args": {"question": "over"},
                               "session_id": "sess-r-X", "requested_by": "alpha"})
        # alpha had 1 from step 1; +4 here = 5 = limit, so the next one should be denied.
        assert r["accepted"] is False
        assert r["reason"] == "quota_exhausted_for_requester"

        # 8. Failures inside the delegated tool surface as accepted=false (not a crash).
        def boom(messages, max_tokens, temperature):
            raise RuntimeError("backend explosion")
        srv.ALL_PROVIDERS["alpha"] = srv.Provider(name="alpha", send=boom, model="m")
        srv.CFG["delegation"] = {"max_per_session": 100, "max_per_requester": 1000}
        r = srv.tool_delegate({"tool_call": "confer", "via": "alpha",
                               "args": {"question": "q"}, "session_id": "deleg-2"})
        # Confer catches the exception and returns it inside answers[0].error rather than raising.
        # So delegate should still report accepted=true with a result whose answer carries an error.
        assert r["accepted"] is True
        assert r["result"]["answers"][0].get("error_kind") == "other"

        # 9. Persistence: delegations table should record both accepted and refused entries.
        with srv._db_conn() as conn:
            n_accepted = conn.execute("SELECT COUNT(*) FROM delegations WHERE accepted = 1").fetchone()[0]
            n_refused  = conn.execute("SELECT COUNT(*) FROM delegations WHERE accepted = 0").fetchone()[0]
        assert n_accepted >= 6,                        f"expected several accepted, got {n_accepted}"
        assert n_refused  >= 4,                        f"expected several refused, got {n_refused}"

        # 10. delegate is in TOOLS.
        assert "delegate" in srv.TOOLS
        assert "tool_call" in srv.TOOLS["delegate"]["inputSchema"]["properties"]

        print("all delegate tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
