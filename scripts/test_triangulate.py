#!/usr/bin/env python3
"""Offline test for the triangulate tool (consensus + minority report + weights)."""

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

    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-tri-"))
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

        # Wire stub providers that always return valid role/synth payloads.
        proposer_p = {
            "role": "proposer", "summary": "x", "confidence": 0.8, "ballot": "agree",
            "claims": [{"claim": "p", "confidence": 0.8}],
        }
        critic_a = {"role": "critic", "summary": "ok", "confidence": 0.7, "ballot": "agree",
                    "claims": [{"claim": "c1", "confidence": 0.7}]}
        critic_d = {"role": "critic", "summary": "no", "confidence": 0.6, "ballot": "disagree",
                    "claims": [{"claim": "c2", "confidence": 0.6}]}
        synth = {
            "consensus": "go with strategy A",
            "weighted_confidence": 0.78,
            "key_claims": [{"claim": "A is simpler", "confidence": 0.85, "supporters": ["alpha"]}],
            "dissent": [{"claim": "B handles edge case Z", "providers": ["delta"],
                         "rationale": "shard skew"}],
            "open_questions": ["how big is Z?"],
        }

        def make_send(payload):
            def s(messages, max_tokens, temperature):
                return (json.dumps(payload), 1)
            return s

        srv.ALL_PROVIDERS = {
            "alpha":     srv.Provider(name="alpha",     send=make_send(proposer_p), model="m"),
            "beta":      srv.Provider(name="beta",      send=make_send(critic_a),   model="m"),
            "delta":     srv.Provider(name="delta",     send=make_send(critic_d),   model="m"),
            "anthropic": srv.Provider(name="anthropic", send=make_send(synth),      model="m"),
        }
        srv.CFG["providers"] = ["alpha", "beta", "delta"]
        srv.CFG["moderator"] = "anthropic"

        # 1. First run: no historical stats -> all weights default to 1.0.
        r1 = srv.tool_triangulate({
            "question": "A vs B?",
            "providers": ["alpha", "beta", "delta"],
            "session_id": "tri-1",
        })
        assert r1["tool"] == "triangulate"
        assert r1["question"] == "A vs B?"
        assert "go with strategy A" in r1["consensus"]
        assert r1["weighted_confidence"] == 0.78
        assert sorted(r1["providers_used"]) == ["alpha", "anthropic", "beta", "delta"]
        weights = {row["provider"]: row["weight"] for row in r1["panel"]}
        assert weights["alpha"] == 1.0,    "no stats yet for alpha"
        assert weights["anthropic"] == 1.0
        # Critics' first ballots were just recorded.
        # beta=agree (1 win), delta=disagree (1 loss). Their *next* run reflects this.
        assert "minority_report" in r1
        assert "B handles edge case Z" in r1["minority_report"]
        assert "shard skew" in r1["minority_report"]

        # 2. Second run: weights now reflect the prior round's ballots.
        r2 = srv.tool_triangulate({
            "question": "again",
            "providers": ["alpha", "beta", "delta"],
            "session_id": "tri-2",
        })
        weights2 = {row["provider"]: row["weight"] for row in r2["panel"]}
        # beta voted agree once -> winrate 1.0; delta disagreed -> winrate 0.0.
        assert weights2["beta"] == 1.0,                f"beta weight: {weights2['beta']}"
        assert weights2["delta"] == 0.0,               f"delta weight: {weights2['delta']}"
        # alpha and anthropic are proposer/synth — they don't cast ballots, so still 1.0.
        assert weights2["alpha"] == 1.0
        assert weights2["anthropic"] == 1.0

        # 3. After three more rounds the ballots accumulate (5 total: tri-1 + tri-2 + 3 here).
        for _ in range(3):
            srv.tool_triangulate({"question": "q", "providers": ["alpha", "beta", "delta"]})
        stats = srv._provider_stats_all()
        assert stats["beta"]["wins"]    == 5,          f"beta wins: {stats['beta']}"
        assert stats["delta"]["losses"] == 5,          f"delta losses: {stats['delta']}"

        # 4. minority_report formatting handles the empty case.
        synth_no_dissent = {**synth, "dissent": []}
        srv.ALL_PROVIDERS["anthropic"] = srv.Provider(
            name="anthropic", send=make_send(synth_no_dissent), model="m")
        r3 = srv.tool_triangulate({"question": "calm question", "providers": ["alpha", "beta"]})
        assert r3["minority_report"] == "(no dissent recorded)"

        # 5. Triangulate is in TOOLS and visible to the JSON-RPC layer.
        assert "triangulate" in srv.TOOLS
        assert "question" in srv.TOOLS["triangulate"]["inputSchema"]["properties"]

        print("all triangulate tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
