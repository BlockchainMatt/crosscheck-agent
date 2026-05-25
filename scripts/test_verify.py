#!/usr/bin/env python3
"""Offline tests for the `verify` tool (PR 15)."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv
    tmp = Path(tempfile.mkdtemp())
    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False

    # ------------------------------------------------------------------
    # 1) Missing / empty checks -> structured error
    # ------------------------------------------------------------------
    err = srv.tool_verify({})
    assert err["error_code"] == "VERIFY_MISSING_CHECKS", err
    err = srv.tool_verify({"checks": []})
    assert err["error_code"] == "VERIFY_MISSING_CHECKS", err

    # ------------------------------------------------------------------
    # 2) Text-pattern checks
    # ------------------------------------------------------------------
    res = srv.tool_verify({"checks": [
        {"kind": "contains",    "id": "has_word",       "target_text": "hello world", "value": "world"},
        {"kind": "not_contains","id": "no_secret",      "target_text": "hello world", "value": "secret"},
        {"kind": "regex_match", "id": "is_email",       "target_text": "a@b.co",      "value": r"\w+@\w+\.\w+"},
        {"kind": "contains_all","id": "all_keywords",   "target_text": "hello dear world", "values": ["hello", "world"]},
        {"kind": "contains_any","id": "any_keyword",    "target_text": "hello world", "values": ["foo", "world", "bar"]},
        {"kind": "min_length",  "id": "long_enough",    "target_text": "abc"*50,      "value": 100},
    ]})
    assert res["tool"] == "verify" and res["all_passed"] is True, res
    assert res["checks_run"] == 6
    for r in res["results"]:
        assert r["passed"], r

    # Failure case: not_contains finds the needle
    res = srv.tool_verify({"checks": [
        {"kind": "not_contains", "id": "no_pii", "target_text": "my email is foo@bar.com", "value": "@"},
    ]})
    assert res["all_passed"] is False
    assert res["results"][0]["passed"] is False
    assert "failed" in res["results"][0]["reason"]

    # ------------------------------------------------------------------
    # 3) Shell check: disabled by default; enabled with allow_shell:true
    # ------------------------------------------------------------------
    res = srv.tool_verify({"checks": [
        {"kind": "shell", "id": "echo", "cmd": "echo ok"},
    ]})
    assert res["results"][0]["passed"] is False
    assert "disabled" in res["results"][0]["reason"]

    res = srv.tool_verify({"allow_shell": True, "checks": [
        {"kind": "shell", "id": "echo",       "cmd": "echo ok", "expect_exit": 0,
         "expect_stdout_contains": "ok"},
        {"kind": "shell", "id": "fail_check", "cmd": "false", "expect_exit": 0},
    ]})
    assert res["results"][0]["passed"] is True, res["results"][0]
    assert res["results"][0].get("exit_code") == 0
    assert res["results"][1]["passed"] is False, res["results"][1]
    assert "exit" in res["results"][1]["reason"]

    # Shell missing cmd -> failed reason
    res = srv.tool_verify({"allow_shell": True, "checks": [
        {"kind": "shell", "id": "no_cmd"},
    ]})
    assert res["results"][0]["passed"] is False
    assert "missing `cmd`" in res["results"][0]["reason"]

    # ------------------------------------------------------------------
    # 4) url_head: gated by fetch.url_allowlist
    # ------------------------------------------------------------------
    srv.CFG["fetch"] = {"enabled": True, "url_allowlist": []}
    res = srv.tool_verify({"checks": [
        {"kind": "url_head", "id": "denied", "url": "https://example.test/"},
    ]})
    assert res["results"][0]["passed"] is False
    assert "allowlist" in res["results"][0]["reason"]

    # Stub urlopen so we can check the gating works for an allowlisted URL.
    srv.CFG["fetch"] = {"enabled": True, "url_allowlist": ["https://example.test/"]}
    class _FakeResp:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): pass
    import urllib.request as urlreq
    real_urlopen = urlreq.urlopen
    urlreq.urlopen = lambda *a, **kw: _FakeResp()
    try:
        res = srv.tool_verify({"checks": [
            {"kind": "url_head", "id": "ok",   "url": "https://example.test/x"},
            {"kind": "url_head", "id": "fail", "url": "https://example.test/x", "expect_status": 404},
        ]})
        assert res["results"][0]["passed"] is True, res["results"][0]
        assert res["results"][1]["passed"] is False, res["results"][1]
        assert res["results"][1].get("status") == 200
    finally:
        urlreq.urlopen = real_urlopen

    # ------------------------------------------------------------------
    # 5) Unknown kind + malformed entry
    # ------------------------------------------------------------------
    res = srv.tool_verify({"checks": [
        {"kind": "wat", "id": "bogus"},
        "not even a dict",
    ]})
    assert res["results"][0]["passed"] is False
    assert "unknown check kind" in res["results"][0]["reason"]
    assert res["results"][1]["passed"] is False
    assert "missing `kind`" in res["results"][1]["reason"]

    print("OK: test_verify")
    return 0


if __name__ == "__main__":
    sys.exit(main())
