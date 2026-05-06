#!/usr/bin/env python3
"""Offline test for the bench tool (rule-based goldens + win-rate)."""

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

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-bench-"))
    try:
        # 1. Verifier kinds work in isolation.
        text = "This regex is vulnerable to ReDoS via catastrophic backtracking."
        assert srv._eval_verifier({"kind": "contains",            "value": "ReDoS"},                 text)[0] is True
        assert srv._eval_verifier({"kind": "contains",            "value": "redos"},                 text)[0] is False
        assert srv._eval_verifier({"kind": "contains",            "value": "redos",
                                   "case_insensitive": True},                                       text)[0] is True
        assert srv._eval_verifier({"kind": "not_contains",        "value": "safe"},                  text)[0] is True
        assert srv._eval_verifier({"kind": "regex_match",         "value": "vulnerab(le|ility)"},    text)[0] is True
        assert srv._eval_verifier({"kind": "contains_any",
                                   "values": ["foo", "catastrophic"]},                              text)[0] is True
        assert srv._eval_verifier({"kind": "contains_all",
                                   "values": ["regex", "ReDoS"]},                                   text)[0] is True
        assert srv._eval_verifier({"kind": "contains_all",
                                   "values": ["regex", "missing"]},                                 text)[0] is False
        assert srv._eval_verifier({"kind": "min_length",          "value": 10},                      text)[0] is True
        assert srv._eval_verifier({"kind": "min_length",          "value": 999},                     text)[0] is False
        # Bad regex stays bounded.
        assert srv._eval_verifier({"kind": "regex_match",         "value": "[unclosed"},             text)[0] is False
        # Unknown kind = fail.
        assert srv._eval_verifier({"kind": "what?", "value": "x"}, text)[0] is False

        # 2. End-to-end bench against three stub providers + two goldens.
        goldens_dir = tmp / "goldens"
        goldens_dir.mkdir()
        (goldens_dir / "redos.json").write_text(json.dumps({
            "name": "redos-detection",
            "tool_call": "review",
            "args": {"snippet": "/(a+)+$/", "intent": "regex safety"},
            "verifiers": [
                {"kind": "contains_any", "values": ["ReDoS", "catastrophic"], "case_insensitive": True},
                {"kind": "min_length", "value": 10},
            ],
        }))
        (goldens_dir / "ttl.json").write_text(json.dumps({
            "name": "ttl-question",
            "tool_call": "confer",
            "args": {"question": "What does TTL stand for?"},
            "verifiers": [
                {"kind": "regex_match", "value": "time[-\\s]?to[-\\s]?live", "case_insensitive": True},
            ],
        }))

        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]      = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]      = str(tmp / "events.ndjson")
        srv.CFG["cache"]           = {"enabled": False}
        srv.CFG["max_time_seconds"] = 10
        srv.CFG["token_cap"]       = 1024
        srv.CFG["provider_allowlist"] = None
        srv.CFG["bench"] = {"goldens_dir": str(goldens_dir)}
        srv._DB_INIT_DONE = False

        # alpha = strong reviewer, weak on TTL    (1 pass / 1 fail)
        # beta  = weak reviewer, strong on TTL    (1 pass / 1 fail)
        # gamma = both perfect                    (2 pass)
        responses = {
            ("alpha", "review"): "Yes, this regex exhibits catastrophic backtracking — classic ReDoS.",
            ("alpha", "confer"): "TTL has many meanings.",
            ("beta",  "review"): "Looks fine to me.",
            ("beta",  "confer"): "Time-to-live counter for caches.",
            ("gamma", "review"): "ReDoS confirmed; nested quantifiers cause catastrophic blowup.",
            ("gamma", "confer"): "TTL = time-to-live.",
        }

        def make_send(provider):
            def s(messages, max_tokens, temperature):
                # The system prompt mentions either "review" or "panel" depending on tool;
                # but the snippet always shows up in messages — easier to detect by content.
                joined = "\n".join(m.get("content", "") for m in messages if isinstance(m, dict))
                inner_tool = "review" if "SNIPPET:" in joined else "confer"
                return (responses[(provider, inner_tool)], 1)
            return s

        srv.ALL_PROVIDERS = {
            "alpha": srv.Provider(name="alpha", send=make_send("alpha"), model="m"),
            "beta":  srv.Provider(name="beta",  send=make_send("beta"),  model="m"),
            "gamma": srv.Provider(name="gamma", send=make_send("gamma"), model="m"),
        }
        srv.CFG["providers"] = ["alpha", "beta", "gamma"]
        srv.CFG["moderator"] = "gamma"

        result = srv.tool_bench({
            "providers": ["alpha", "beta", "gamma"],
            "session_id": "bench-1",
        })
        assert result["tool"] == "bench"
        assert result["goldens_run"] == 2
        rbp = result["results_by_provider"]
        assert rbp["alpha"]["passed"] == 1 and rbp["alpha"]["failed"] == 1
        assert rbp["beta"]["passed"]  == 1 and rbp["beta"]["failed"]  == 1
        assert rbp["gamma"]["passed"] == 2 and rbp["gamma"]["failed"] == 0
        assert rbp["alpha"]["score"] == 0.5
        assert rbp["beta"]["score"]  == 0.5
        assert rbp["gamma"]["score"] == 1.0
        # Ranking sorted by score desc.
        assert result["ranking"][0]["provider"] == "gamma"
        assert result["ranking"][0]["score"] == 1.0
        # Each detail entry has a verifiers array unless errored.
        for det in rbp["gamma"]["details"]:
            assert det["passed"] is True
            assert det["errored"] is False
            assert len(det["verifiers"]) >= 1
            assert all(v["passed"] is True for v in det["verifiers"])

        # 3. Win-rate from bench feeds triangulate weights.
        weights = srv._provider_weights(["alpha", "beta", "gamma"])
        assert weights["gamma"] == 1.0
        assert weights["alpha"] == 0.5
        assert weights["beta"]  == 0.5

        # 4. filter only runs matching goldens.
        result = srv.tool_bench({
            "providers": ["alpha"],
            "filter": "redos",
        })
        assert result["goldens_run"] == 1
        assert result["results_by_provider"]["alpha"]["passed"] == 1

        # 5. Empty goldens directory returns goldens_run=0 without error.
        empty = tmp / "empty-goldens"; empty.mkdir()
        result = srv.tool_bench({"providers": ["alpha"], "goldens_dir": str(empty)})
        assert result["goldens_run"] == 0
        assert result["results_by_provider"]["alpha"]["score"] == 0.0

        # 6. Provider error path: stub raises.
        def boom(messages, max_tokens, temperature):
            raise RuntimeError("backend down")
        srv.ALL_PROVIDERS["alpha"] = srv.Provider(name="alpha", send=boom, model="m")
        result = srv.tool_bench({"providers": ["alpha"], "goldens_dir": str(goldens_dir)})
        assert result["results_by_provider"]["alpha"]["errored"] >= 1
        # Should still have a deterministic shape.
        assert "score" in result["results_by_provider"]["alpha"]

        # 7. Tool registered.
        assert "bench" in srv.TOOLS

        print("all bench tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
