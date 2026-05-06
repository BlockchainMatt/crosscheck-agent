#!/usr/bin/env python3
"""Offline test for the solve tool (iterative propose -> verify -> retry)."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-solve-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]      = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]      = str(tmp / "events.ndjson")
        srv.CFG["cache"]           = {"enabled": False}
        srv.CFG["max_time_seconds"] = 30
        srv.CFG["token_cap"]       = 1024
        srv.CFG["provider_allowlist"] = None
        srv._DB_INIT_DONE = False

        # ---- 1. Direct verifier checks (no provider needed) ----
        # regex_response: pass and fail.
        v_re = {"kind": "regex_response", "pattern": r"42"}
        assert srv._verify_proposal(v_re, "the answer is 42")["passed"] is True
        assert srv._verify_proposal(v_re, "no number here")["passed"] is False
        # Bad regex.
        v_bad = {"kind": "regex_response", "pattern": "[unclosed"}
        r = srv._verify_proposal(v_bad, "anything")
        assert r["passed"] is False and "bad regex" in r["error"]
        # case_insensitive
        v_ci = {"kind": "regex_response", "pattern": "HELLO", "case_insensitive": True}
        assert srv._verify_proposal(v_ci, "hello world")["passed"] is True
        # Unknown kind.
        assert srv._verify_proposal({"kind": "?"}, "x")["passed"] is False

        # shell verifier: cat the proposal back; check exit + substring.
        v_shell_ok = {
            "kind": "shell",
            "cmd": ["python3", "-c", "import sys; sys.stdout.write(sys.stdin.read())"],
            "expect_exit_code": 0, "expect_stdout_contains": "needle",
            "timeout_s": 5,
        }
        r = srv._verify_proposal(v_shell_ok, "...needle...")
        assert r["passed"] is True
        assert r["exit_code"] == 0
        r = srv._verify_proposal(v_shell_ok, "no match")
        assert r["passed"] is False
        assert "missing substring" in r["error"]

        # shell verifier: regex on stdout
        v_shell_re = {
            "kind": "shell",
            "cmd": ["python3", "-c", "import sys; sys.stdout.write(sys.stdin.read())"],
            "expect_exit_code": 0, "expect_stdout_regex": r"^\d+\s+\d+$",
            "timeout_s": 5,
        }
        assert srv._verify_proposal(v_shell_re, "13 42")["passed"] is True
        assert srv._verify_proposal(v_shell_re, "13a 42")["passed"] is False

        # shell timeout.
        v_timeout = {"kind": "shell",
                     "cmd": ["python3", "-c", "import time; time.sleep(5)"],
                     "timeout_s": 0.3}
        r = srv._verify_proposal(v_timeout, "")
        assert r["passed"] is False and "timeout" in r["error"]

        # shell command not found.
        v_nf = {"kind": "shell", "cmd": ["this-binary-does-not-exist-xyz"], "timeout_s": 1}
        r = srv._verify_proposal(v_nf, "")
        assert r["passed"] is False and "not found" in r["error"]

        # shell with non-zero expected exit.
        v_nonzero = {"kind": "shell",
                     "cmd": ["python3", "-c", "import sys; sys.exit(42)"],
                     "expect_exit_code": 42, "timeout_s": 5}
        assert srv._verify_proposal(v_nonzero, "")["passed"] is True

        # ---- 2. End-to-end: stub provider that needs feedback to converge ----
        # First proposal is wrong; on retry the provider sees the failure and corrects.
        attempts = {"n": 0}
        def chatty_send(messages, max_tokens, temperature):
            attempts["n"] += 1
            joined = "\n".join(m.get("content", "") for m in messages if isinstance(m, dict))
            if attempts["n"] == 1:
                return ("hello world", 1)  # missing 'needle'
            # On retry the feedback is in messages; check the model "saw" it.
            assert "FAILED" in joined, "feedback not propagated"
            return ("here is the needle", 1)
        srv.ALL_PROVIDERS = {"alpha": srv.Provider(name="alpha", send=chatty_send, model="m")}
        srv.CFG["providers"] = ["alpha"]

        result = srv.tool_solve({
            "problem": "produce text containing the word needle",
            "verifier": v_shell_ok,
            "providers": ["alpha"],
            "max_attempts": 3,
            "session_id": "solve-1",
        })
        assert result["tool"] == "solve"
        assert result["solved"] is True
        assert result["winning_provider"] == "alpha"
        assert result["final_proposal"] == "here is the needle"
        assert len(result["attempts"]) == 2
        assert result["attempts"][0]["verification"]["passed"] is False
        assert result["attempts"][1]["verification"]["passed"] is True

        # ---- 3. Failure path: proposal never satisfies verifier ----
        attempts["n"] = 0
        def stuck_send(messages, max_tokens, temperature):
            return ("never the right answer", 1)
        srv.ALL_PROVIDERS = {"alpha": srv.Provider(name="alpha", send=stuck_send, model="m")}
        result = srv.tool_solve({
            "problem": "p",
            "verifier": {"kind": "regex_response", "pattern": "WILL_NEVER_MATCH"},
            "providers": ["alpha"],
            "max_attempts": 3,
        })
        assert result["solved"] is False
        assert result["final_proposal"] is None
        assert len(result["attempts"]) == 3
        assert all(a["verification"]["passed"] is False for a in result["attempts"])

        # ---- 4. Provider rotation across multiple providers ----
        order: list[str] = []
        def make_send(name, payload):
            def s(messages, max_tokens, temperature):
                order.append(name)
                return (payload, 1)
            return s
        srv.ALL_PROVIDERS = {
            "alpha": srv.Provider(name="alpha", send=make_send("alpha", "wrong"), model="m"),
            "beta":  srv.Provider(name="beta",  send=make_send("beta",  "wrong"), model="m"),
            "gamma": srv.Provider(name="gamma", send=make_send("gamma", "needle present"), model="m"),
        }
        result = srv.tool_solve({
            "problem": "p",
            "verifier": v_shell_ok,
            "providers": ["alpha", "beta", "gamma"],
            "max_attempts": 4,
        })
        assert order[:3] == ["alpha", "beta", "gamma"], f"rotation order wrong: {order}"
        assert result["solved"] is True
        assert result["winning_provider"] == "gamma"
        assert len(result["attempts"]) == 3

        # ---- 5. Provider error mid-loop is recorded, not fatal ----
        def boom(messages, max_tokens, temperature):
            raise RuntimeError("backend down")
        def good(messages, max_tokens, temperature):
            return ("needle here", 1)
        srv.ALL_PROVIDERS = {
            "alpha": srv.Provider(name="alpha", send=boom, model="m"),
            "beta":  srv.Provider(name="beta",  send=good, model="m"),
        }
        result = srv.tool_solve({
            "problem": "p",
            "verifier": v_shell_ok,
            "providers": ["alpha", "beta"],
            "max_attempts": 2,
        })
        assert result["solved"] is True
        assert result["winning_provider"] == "beta"
        # First attempt has an error AND a failed verification record.
        first = result["attempts"][0]
        assert first["verification"]["passed"] is False
        assert "error" in first

        # ---- 6. Tool registered ----
        assert "solve" in srv.TOOLS

        print("all solve tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
