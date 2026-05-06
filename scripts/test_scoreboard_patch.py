#!/usr/bin/env python3
"""Offline tests for the scoreboard tool and solve's patch-preview output."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-uxtest-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]      = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]      = str(tmp / "events.ndjson")
        srv.CFG["cache"]           = {"enabled": False}
        srv.CFG["max_time_seconds"] = 10
        srv.CFG["token_cap"]       = 1024
        srv.CFG["provider_allowlist"] = None
        srv._DB_INIT_DONE = False

        # ---- 1. Empty scoreboard returns sane shape ----
        srv._db_init()
        r = srv.tool_scoreboard({})
        assert r["tool"] == "scoreboard"
        assert r["providers"] == []
        assert r["totals"] == {"sessions": 0, "claims": 0, "claim_links": 0, "delegations": 0}

        # ---- 2. After bench-style ballots, scoreboard reflects win-rate ----
        for _ in range(3):
            srv._record_ballot("alpha",   "agree")
            srv._record_ballot("alpha",   "agree")
            srv._record_ballot("beta",    "disagree")
            srv._record_ballot("gamma",   "agree")
            srv._record_ballot("gamma",   "abstain")
        r = srv.tool_scoreboard({})
        names = [p["provider"] for p in r["providers"]]
        assert sorted(names) == ["alpha", "beta", "gamma"], f"got {names}"
        weights = {p["provider"]: p["weight"] for p in r["providers"]}
        assert weights["alpha"] == 1.0  # 6 wins / 6 committed
        assert weights["beta"]  == 0.0  # 3 losses
        assert weights["gamma"] == 1.0  # 3 wins, 3 abstains -> 3/3 committed
        # Ranking: ties broken by total committed (alpha=6, beta=3, gamma=3 -> alpha first).
        assert r["providers"][0]["provider"] == "alpha"

        # ---- 3. Delegation counts populate when recorded ----
        srv._delegation_record("ses-1", "alpha", "confer", "beta", accepted=True)
        srv._delegation_record("ses-1", "alpha", "confer", "beta", accepted=True)
        srv._delegation_record("ses-1", "alpha", "confer", "gamma", accepted=False)
        r = srv.tool_scoreboard({})
        a = next(p for p in r["providers"] if p["provider"] == "alpha")
        assert a["delegations_accepted"] == 2
        assert a["delegations_refused"]  == 1
        assert r["totals"]["delegations"] == 3

        # ---- 4. recent_limit pulls last N event lines, post-redaction ----
        # Emit two events; second contains redactable content.
        srv._emit_event("provider_call", provider="alpha", model="m",
                        cache_hit=False, elapsed_ms=12, attempts=1)
        srv._emit_event("provider_call", provider="beta", model="m",
                        cache_hit=False, elapsed_ms=15, attempts=1,
                        sensitive="alice@example.com")
        r = srv.tool_scoreboard({"recent_limit": 5})
        assert isinstance(r["recent_events"], list)
        assert len(r["recent_events"]) >= 2
        # Find the redacted line: the 'sensitive' field should be scrubbed.
        for ev in r["recent_events"]:
            if ev.get("sensitive"):
                assert "alice@" not in ev["sensitive"]
                assert "[REDACTED_EMAIL]" in ev["sensitive"]

        # ---- 5. top_k caps the leaderboard ----
        r = srv.tool_scoreboard({"top_k": 1})
        assert len(r["providers"]) == 1

        # ---- 6. solve patch preview: replacement text vs existing file ----
        target = tmp / "target.py"
        target.write_text("def f():\n    return 1\n")
        # Stub provider that emits a one-shot correct solution.
        def stub(messages, max_tokens, temperature):
            return ("def f():\n    return 42\n", 1)
        srv.ALL_PROVIDERS = {"alpha": srv.Provider(name="alpha", send=stub, model="m")}
        srv.CFG["providers"] = ["alpha"]

        result = srv.tool_solve({
            "problem": "make f() return 42",
            "verifier": {"kind": "regex_response", "pattern": r"return 42"},
            "providers": ["alpha"],
            "target_path": str(target),
            "max_attempts": 1,
        })
        assert result["solved"] is True
        assert result["target_path"] == str(target)
        assert isinstance(result["patch"], str)
        assert "-    return 1" in result["patch"]
        assert "+    return 42" in result["patch"]
        # File must NOT have been modified.
        assert target.read_text() == "def f():\n    return 1\n"

        # ---- 7. solve patch preview: target doesn't exist -> patch labels new file ----
        nonexistent = tmp / "newfile.py"
        result = srv.tool_solve({
            "problem": "create newfile",
            "verifier": {"kind": "regex_response", "pattern": r"return 42"},
            "providers": ["alpha"],
            "target_path": str(nonexistent),
            "max_attempts": 1,
        })
        assert result["solved"] is True
        assert "(new file)" in (result["patch"] or "")
        assert not nonexistent.exists()

        # ---- 8. solve without target_path: no patch field ----
        result = srv.tool_solve({
            "problem": "x",
            "verifier": {"kind": "regex_response", "pattern": r"return 42"},
            "providers": ["alpha"],
            "max_attempts": 1,
        })
        assert result["solved"] is True
        assert "patch" not in result
        assert "target_path" not in result

        # ---- 9. solve unsuccessful + target_path: still no patch ----
        def bad_stub(messages, max_tokens, temperature):
            return ("nope", 1)
        srv.ALL_PROVIDERS = {"alpha": srv.Provider(name="alpha", send=bad_stub, model="m")}
        result = srv.tool_solve({
            "problem": "fail",
            "verifier": {"kind": "regex_response", "pattern": r"WILL_NEVER_MATCH"},
            "providers": ["alpha"],
            "target_path": str(target),
            "max_attempts": 1,
        })
        assert result["solved"] is False
        assert result.get("patch") is None

        # ---- 10. scoreboard tool registered ----
        assert "scoreboard" in srv.TOOLS

        print("all scoreboard + patch-preview tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
