#!/usr/bin/env python3
"""Offline tests for update_crosscheck and the first-call update notice.

We stub _remote_main_sha so no network is touched, and stub subprocess.run
for the apply path so no real `git pull` runs against the working tree.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-update-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["update_cache_path"] = str(tmp / "uc.json")
        srv.CFG["session_db"]        = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"]   = False
        srv.CFG["events_log"]        = str(tmp / "events.ndjson")
        srv.CFG["cache"]             = {"enabled": False}
        srv.CFG["max_time_seconds"]  = 5
        srv.CFG["token_cap"]         = 1024
        srv.CFG["provider_allowlist"] = None
        srv._DB_INIT_DONE = False

        # ---- 1. _local_git_sha against the actual repo returns a real SHA ----
        sha = srv._local_git_sha()
        assert sha is not None,                           "_local_git_sha must return a SHA in this checkout"
        assert len(sha) >= 7 and all(c in "0123456789abcdef" for c in sha)

        # ---- 2. up_to_date when remote SHA matches local ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)

        orig_remote = srv._remote_main_sha
        orig_rel = srv._git_relationship
        srv._remote_main_sha = lambda timeout=3.0: sha
        try:
            r = srv.tool_update_crosscheck({})
            assert r["status"] == "up_to_date",           f"expected up_to_date, got {r}"
            assert r["update_available"] is False
            assert r["current_sha"] == sha[:12]
            assert r["latest_sha"]  == sha[:12]
            assert r["relationship"] == "equal"
            cached = json.loads(Path(srv.CFG["update_cache_path"]).read_text())
            assert cached["update_available"] is False
        finally:
            srv._remote_main_sha = orig_remote

        # ---- 3. update_available: stub _git_relationship to report 'behind'  ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)
        FAKE_REMOTE = "deadbeef" + sha[8:]

        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("behind", 0, 3)
        try:
            r = srv.tool_update_crosscheck({})
            assert r["status"] == "update_available",      f"expected update_available, got {r}"
            assert r["update_available"] is True
            assert r["relationship"] == "behind"
            assert r["behind"] == 3
            assert "next_step" in r
            cached = json.loads(Path(srv.CFG["update_cache_path"]).read_text())
            assert cached["update_available"] is True
            assert "notice" in cached and cached["notice"]["update_available"] is True
            assert cached["notice"]["behind_count"] == 3
        finally:
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel

        # ---- 3b. local_ahead: differing SHA but local is ahead -> NO upgrade ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)
        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("ahead", 5, 0)
        try:
            r = srv.tool_update_crosscheck({})
            assert r["status"] == "local_ahead",           f"expected local_ahead, got {r}"
            assert r["update_available"] is False
            assert r["ahead"] == 5
            assert "ahead" in r["next_step"].lower()
            cached = json.loads(Path(srv.CFG["update_cache_path"]).read_text())
            assert cached["update_available"] is False
            assert "notice" not in cached
        finally:
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel

        # ---- 3c. diverged: both ahead and behind -> refuse ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)
        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("diverged", 2, 4)
        try:
            r = srv.tool_update_crosscheck({})
            assert r["status"] == "diverged",              f"expected diverged, got {r}"
            assert r["update_available"] is False
            assert r["ahead"] == 2 and r["behind"] == 4
            assert "diverged" in r["next_step"].lower() or "manual" in r["next_step"].lower()
        finally:
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel

        # ---- 3d. unknown ancestry: refuse, surface error ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)
        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("unknown", None, None)
        try:
            r = srv.tool_update_crosscheck({})
            assert r["status"] == "error"
            assert "ancestry" in r["reason"]
        finally:
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel

        # ---- 4. apply=true success path (subprocess.run stubbed for `git pull` only) ----
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)

        orig_subprocess_run = subprocess.run

        class FakeCP:
            returncode = 0
            stdout = "Already up to date.\n"
            stderr = ""
        captured_calls = []
        def selective_run(cmd, **kw):
            # Only intercept `git pull`; let `git rev-parse HEAD` (and anything else)
            # fall through to the real binary so _local_git_sha keeps working.
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "pull":
                captured_calls.append((cmd, kw.get("cwd")))
                return FakeCP()
            return orig_subprocess_run(cmd, **kw)

        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("behind", 0, 7)
        subprocess.run = selective_run
        try:
            r = srv.tool_update_crosscheck({"apply": True})
        finally:
            subprocess.run = orig_subprocess_run
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel
        assert r["status"] == "updated",                  f"expected updated, got {r}"
        assert r["restart_required"] is True
        assert "restart" in r["restart_instructions"].lower()
        assert captured_calls, "subprocess.run was never invoked for git pull"
        assert captured_calls[0][0] == ["git", "pull", "--ff-only"]

        # ---- 5. apply=true failure path (non-zero exit code) ----
        class FakeCPFail:
            returncode = 1
            stdout = ""
            stderr = "fatal: Not possible to fast-forward, aborting.\n"
        def selective_fail(cmd, **kw):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "pull":
                return FakeCPFail()
            return orig_subprocess_run(cmd, **kw)
        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("behind", 0, 7)
        subprocess.run = selective_fail
        try:
            r = srv.tool_update_crosscheck({"apply": True})
        finally:
            subprocess.run = orig_subprocess_run
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel
        assert r["status"] == "pull_failed"
        assert r["exit_code"] == 1
        assert "fast-forward" in r["stderr"]

        # ---- 6. error path: cannot reach GitHub ----
        srv._remote_main_sha = lambda timeout=3.0: None
        try:
            r = srv.tool_update_crosscheck({})
        finally:
            srv._remote_main_sha = orig_remote
        assert r["status"] == "error"
        assert "GitHub" in r["reason"] or "github" in r["reason"]

        # ---- 7. _maybe_check_for_updates uses the disk cache within TTL ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        # Pre-seed the cache with an "update available" record.
        seeded = {
            "checked_at": int(__import__("time").time()),
            "update_available": True,
            "current_sha": sha,
            "latest_sha":  FAKE_REMOTE,
            "relationship": "behind", "ahead": 0, "behind": 7,
            "notice": srv._build_update_notice(sha, FAKE_REMOTE, behind_count=7),
        }
        Path(srv.CFG["update_cache_path"]).write_text(json.dumps(seeded))

        net_calls = {"n": 0}
        def must_not_be_called(timeout=3.0):
            net_calls["n"] += 1
            return None
        srv._remote_main_sha = must_not_be_called
        try:
            n = srv._maybe_check_for_updates()
        finally:
            srv._remote_main_sha = orig_remote
        assert isinstance(n, dict),                        f"expected cached notice, got {n!r}"
        assert n["update_available"] is True
        assert net_calls["n"] == 0,                        "cached path must not call the network"

        # ---- 8. The notice is attached to OTHER tool results via tools/call ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).write_text(json.dumps(seeded))  # cache says: update available
        srv._remote_main_sha = must_not_be_called  # ensure no network

        try:
            req = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": "list_providers", "arguments": {}}}
            resp = srv.handle(req)
        finally:
            srv._remote_main_sha = orig_remote
        text = resp["result"]["content"][0]["text"]
        payload = json.loads(text)
        assert "update_notice" in payload,                 f"notice not attached to list_providers result: {payload!r}"
        assert payload["update_notice"]["update_available"] is True

        # ---- 9. The notice is NOT attached to update_crosscheck's own result ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).write_text(json.dumps(seeded))
        srv._remote_main_sha = lambda timeout=3.0: FAKE_REMOTE
        srv._git_relationship = lambda l, r: ("behind", 0, 7)
        try:
            req = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": "update_crosscheck", "arguments": {}}}
            resp = srv.handle(req)
        finally:
            srv._remote_main_sha = orig_remote
            srv._git_relationship = orig_rel
        payload = json.loads(resp["result"]["content"][0]["text"])
        assert "update_notice" not in payload,             "update_crosscheck must not nest a notice in itself"
        assert payload["status"] == "update_available"

        # ---- 10. _UPDATE_CHECKED prevents re-running the check on subsequent calls ----
        srv._UPDATE_CHECKED = False
        srv._UPDATE_NOTICE = None
        Path(srv.CFG["update_cache_path"]).unlink(missing_ok=True)
        check_calls = {"n": 0}
        def counted(timeout=3.0):
            check_calls["n"] += 1
            return FAKE_REMOTE
        srv._remote_main_sha = counted
        try:
            srv._maybe_check_for_updates()
            srv._maybe_check_for_updates()
            srv._maybe_check_for_updates()
        finally:
            srv._remote_main_sha = orig_remote
        assert check_calls["n"] <= 1,                      f"check ran {check_calls['n']} times, expected 1"

        # ---- 11. Tool registered ----
        assert "update_crosscheck" in srv.TOOLS

        print("all update_crosscheck tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
