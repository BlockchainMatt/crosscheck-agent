#!/usr/bin/env python3
"""Offline test for the pick tool (MCDA + dissent deltas)."""

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

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-pick-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]      = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]      = str(tmp / "events.ndjson")
        srv.CFG["cache"]           = {"enabled": False}
        srv.CFG["max_time_seconds"] = 10
        srv.CFG["token_cap"]       = 8192
        srv.CFG["provider_allowlist"] = None
        srv._DB_INIT_DONE = False

        # 3 providers: alpha and beta agree (Postgres > Mongo on consistency);
        # gamma is the contrarian on consistency. They mostly agree on cost.
        alpha_payload = {
            "scores": [
                {"option": "Postgres", "overall": 0.85, "by_criterion": [
                    {"criterion": "consistency", "score": 0.95, "rationale": "ACID baseline"},
                    {"criterion": "cost",        "score": 0.6}
                ]},
                {"option": "Mongo",    "overall": 0.55, "by_criterion": [
                    {"criterion": "consistency", "score": 0.4},
                    {"criterion": "cost",        "score": 0.7}
                ]},
            ]
        }
        beta_payload = {
            "scores": [
                {"option": "Postgres", "overall": 0.8, "by_criterion": [
                    {"criterion": "consistency", "score": 0.9},
                    {"criterion": "cost",        "score": 0.65}
                ]},
                {"option": "Mongo",    "overall": 0.5, "by_criterion": [
                    {"criterion": "consistency", "score": 0.45},
                    {"criterion": "cost",        "score": 0.7}
                ]},
            ]
        }
        gamma_payload = {
            "scores": [
                # gamma sharply disagrees on Mongo's consistency.
                {"option": "Postgres", "overall": 0.75, "by_criterion": [
                    {"criterion": "consistency", "score": 0.85},
                    {"criterion": "cost",        "score": 0.6}
                ]},
                {"option": "Mongo",    "overall": 0.7, "by_criterion": [
                    {"criterion": "consistency", "score": 0.95, "rationale": "tunable"},
                    {"criterion": "cost",        "score": 0.7}
                ]},
            ]
        }

        def make_send(payload):
            def s(messages, max_tokens, temperature):
                return (json.dumps(payload), 1)
            return s

        srv.ALL_PROVIDERS = {
            "alpha": srv.Provider(name="alpha", send=make_send(alpha_payload), model="m"),
            "beta":  srv.Provider(name="beta",  send=make_send(beta_payload),  model="m"),
            "gamma": srv.Provider(name="gamma", send=make_send(gamma_payload), model="m"),
        }
        srv.CFG["providers"] = ["alpha", "beta", "gamma"]
        srv.CFG["moderator"] = "alpha"

        # 1. Happy path.
        result = srv.tool_pick({
            "decision": "Postgres or Mongo for the orders service?",
            "options": ["Postgres", "Mongo"],
            "criteria": [
                {"name": "consistency", "weight": 2.0, "description": "strong consistency"},
                {"name": "cost",        "weight": 1.0},
            ],
            "providers": ["alpha", "beta", "gamma"],
            "session_id": "pick-1",
        })
        assert result["tool"] == "pick"
        assert sorted(result["providers_used"]) == ["alpha", "beta", "gamma"]
        # Postgres should rank first thanks to consistency weight.
        assert result["ranking"][0]["option"] == "Postgres"
        assert result["ranking"][0]["rank"] == 1
        assert result["ranking"][1]["option"] == "Mongo"
        # Each option has by_criterion with mean and stddev for both criteria.
        for row in result["ranking"]:
            assert {c["criterion"] for c in row["by_criterion"]} == {"consistency", "cost"}
            for c in row["by_criterion"]:
                assert 0.0 <= c["mean_score"] <= 1.0
                assert c["stddev"] >= 0.0

        # 2. Dissent deltas: highest stddev should be Mongo / consistency.
        top_dissent = result["dissent_deltas"][0]
        assert top_dissent["option"] == "Mongo"
        assert top_dissent["criterion"] == "consistency"
        # All three providers should appear in that delta with their distinct scores.
        scores = sorted(d["score"] for d in top_dissent["providers"])
        assert scores[0] == 0.4 and scores[-1] == 0.95
        # gamma's rationale ("tunable") should be carried.
        ratls = [d.get("rationale", "") for d in top_dissent["providers"]]
        assert any("tunable" in r for r in ratls)

        # 3. Persistence: session has a pick consensus claim.
        claims = srv._session_claims("pick-1")
        assert any(c["kind"] == "consensus" and "Postgres" in c["text"] for c in claims), \
            f"no consensus claim found: {claims!r}"

        # 4. Validation: <2 options or 0 criteria errors out cleanly.
        r2 = srv.tool_pick({"decision": "x", "options": ["only"],
                            "criteria": [{"name": "c"}], "providers": ["alpha"]})
        assert r2.get("error") and "options" in r2["error"]

        # 5. One provider fails to emit valid JSON; others still aggregate.
        def bad_send(messages, max_tokens, temperature):
            return ("not json at all", 1)
        srv.ALL_PROVIDERS["beta"] = srv.Provider(name="beta", send=bad_send, model="m")
        r3 = srv.tool_pick({
            "decision": "again",
            "options": ["Postgres", "Mongo"],
            "criteria": [{"name": "consistency"}, {"name": "cost"}],
            "providers": ["alpha", "beta", "gamma"],
        })
        assert r3["scoring_errors"].get("beta"), f"expected beta error, got {r3.get('scoring_errors')}"
        # alpha and gamma scores still aggregate -> Postgres still wins.
        assert r3["ranking"][0]["option"] == "Postgres"

        # 6. Tool registered.
        assert "pick" in srv.TOOLS

        print("all pick tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
