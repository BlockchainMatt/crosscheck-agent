#!/usr/bin/env python3
"""Offline tests for `explain` (read-only session replay) and `critique`
(panel of pre-mortem-style weakness listings).

Exit 0 on success.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp())
    pricing = tmp / "pricing.json"
    pricing.write_text(json.dumps({
        "openai":    {"gpt-test":   {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test":{"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test":  {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test"}]},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ENV["XAI_API_KEY"]       = "stub"; srv.ENV["XAI_MODEL"]       = "grok-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # 1) explain: error envelopes
    # ------------------------------------------------------------------
    err = srv.tool_explain({})
    assert err["error_code"] == "EXPLAIN_MISSING_SESSION_ID", err

    err = srv.tool_explain({"session_id": "does-not-exist"})
    assert err["error_code"] == "EXPLAIN_NO_SESSION", err

    # ------------------------------------------------------------------
    # 2) explain: replay a session with seeded usage_log + transcript
    # ------------------------------------------------------------------
    # Seed: simulate a confer + audit pair on session "explain-test".
    confer_answers = [
        {"provider": "openai",    "model": "gpt-test",   "response": "ok",
         "cache_hit": False, "elapsed_ms": 100, "cpu_ms": 1, "attempts": 1,
         "usage": {"provider": "openai", "model": "gpt-test",
                   "prompt_tokens": 80, "completion_tokens": 30,
                   "cached_tokens": 0, "total_tokens": 110,
                   "cost_usd": 0.000017, "estimated": False, "purpose": "confer"}},
        {"provider": "anthropic", "model": "claude-test","response": "ok",
         "cache_hit": False, "elapsed_ms": 1500, "cpu_ms": 5, "attempts": 1,
         "usage": {"provider": "anthropic", "model": "claude-test",
                   "prompt_tokens": 80, "completion_tokens": 30,
                   "cached_tokens": 0, "total_tokens": 110,
                   "cost_usd": 0.000690, "estimated": False, "purpose": "confer"}},
    ]
    audit_answers = [
        {"provider": "xai", "model": "grok-test", "response": "{}",
         "cache_hit": False, "elapsed_ms": 800, "cpu_ms": 3, "attempts": 1,
         "usage": {"provider": "xai", "model": "grok-test",
                   "prompt_tokens": 200, "completion_tokens": 80,
                   "cached_tokens": 0, "total_tokens": 280,
                   "cost_usd": 0.00220, "estimated": False, "purpose": "audit"}},
    ]
    sess = srv._session_load("explain-test")
    srv._session_record(sess, confer_answers + audit_answers,
                        call_started=0.0, cpu_started=0.0)
    srv._session_save(sess)
    srv.log_usage("explain-test", "confer", confer_answers)
    srv.log_usage("explain-test", "audit",  audit_answers)

    # Drop a fake transcript so the transcripts-array isn't empty.
    Path(srv.CFG["transcript_dir"]).mkdir(parents=True, exist_ok=True)
    Path(srv.CFG["transcript_dir"], "1000-confer.json").write_text(json.dumps({
        "tool":     "confer",
        "question": "is the sky blue?",
        "answers":  [{"provider": "openai"}, {"provider": "anthropic"}],
        "claims":   [{"text": "yes"}, {"text": "mostly"}],
        "session":  {"session_id": "explain-test"},
        "budget":   {"total_cost_usd": 0.00071, "wall_used_ms": 1600, "cpu_used_ms": 6},
    }))

    res = srv.tool_explain({"session_id": "explain-test"})
    assert res["tool"] == "explain"
    assert res["session_id"] == "explain-test"
    # Totals from the sessions row.
    assert res["totals"]["calls"] == 3, res["totals"]
    assert res["totals"]["total_tokens"] == 500, res["totals"]
    # By-purpose rollup.
    assert "confer" in res["by_purpose"] and "audit" in res["by_purpose"], res["by_purpose"]
    assert res["by_purpose"]["confer"]["calls"] == 2
    assert res["by_purpose"]["audit"]["calls"]  == 1
    # By-provider rollup.
    assert set(res["by_provider"].keys()) == {"openai", "anthropic", "xai"}
    # Transcripts surfaced.
    assert len(res["transcripts"]) == 1
    assert res["transcripts"][0]["tool"] == "confer"
    assert res["transcripts"][0].get("claims_count") == 2
    # Pre-rendered text included by default.
    assert isinstance(res.get("text"), str)
    assert "session: explain-test" in res["text"]
    assert "confer" in res["text"] and "audit" in res["text"]

    # include_text:false suppresses the ASCII tree.
    res2 = srv.tool_explain({"session_id": "explain-test", "include_text": False})
    assert "text" not in res2

    # ------------------------------------------------------------------
    # 3) critique: missing proposal -> structured error
    # ------------------------------------------------------------------
    err = srv.tool_critique({})
    assert err["error_code"] == "CRITIQUE_MISSING_PROPOSAL"
    err = srv.tool_critique({"proposal": "  "})
    assert err["error_code"] == "CRITIQUE_MISSING_PROPOSAL"

    # ------------------------------------------------------------------
    # 4) critique: panel-of-3 returns per-provider weakness lists +
    # merged list ordered by severity
    # ------------------------------------------------------------------
    def fake_post_resilient(url, headers, body, timeout, deadline):
        if "openai" in url:
            return ({"choices": [{"message": {"content": json.dumps({
                "weaknesses": [
                    {"id": "w1", "weakness": "fails edge case X",  "why_matters": "data loss", "severity": "high"},
                    {"id": "w2", "weakness": "no rollback path",   "why_matters": "ops",       "severity": "med"},
                ]})}}],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, 1)
        if "anthropic" in url:
            return ({"content": [{"type": "text", "text": json.dumps({
                "weaknesses": [
                    {"id": "w1", "weakness": "race in writer",     "why_matters": "corruption", "severity": "high"},
                    {"id": "w2", "weakness": "naming inconsistent","why_matters": "review",     "severity": "low"},
                ]})}],
                     "usage": {"input_tokens": 100, "output_tokens": 50}}, 1)
        if "x.ai" in url:
            return ({"choices": [{"message": {"content": json.dumps({
                "weaknesses": [
                    {"id": "w1", "weakness": "untested error path", "why_matters": "incidents", "severity": "med"},
                ]})}}],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post_resilient

    res = srv.tool_critique({
        "proposal":   "Refactor the auth middleware to use opaque tokens.",
        "question":   "Should we switch from JWT to opaque tokens?",
        "providers":  ["openai", "anthropic", "xai"],
        "session_id": "critique-test",
    })
    assert res["tool"] == "critique" and "error" not in res, res
    assert res["providers"] == ["openai", "anthropic", "xai"]
    assert len(res["per_provider"]) == 3
    for pp in res["per_provider"]:
        assert pp["status"] == "ok", pp
    # Merged list: 2 high (openai, anthropic), 2 med (openai, xai), 1 low (anthropic) = 5 total.
    assert len(res["weaknesses"]) == 5
    severities = [w["severity"] for w in res["weaknesses"]]
    # Sorted: all 'high' first, then 'med', then 'low'.
    assert severities == sorted(severities, key=lambda s: {"high":0,"med":1,"low":2}[s]), severities
    assert res["high_severity_count"] == 2
    # Usage rolled up under the session id.
    with srv._db_conn() as conn:
        rs = conn.execute(
            "SELECT COUNT(*), SUM(total_tokens) FROM usage_log "
            "WHERE session_id = ? AND tool = 'critique'", ("critique-test",)
        ).fetchone()
        assert rs[0] == 3
        assert rs[1] > 0

    # ------------------------------------------------------------------
    # 5) critique: panelist that returns malformed JSON -> status='parse_error',
    # other panelists' weaknesses still surface.
    # ------------------------------------------------------------------
    def parse_fail_post(url, headers, body, timeout, deadline):
        if "openai" in url:
            return ({"choices": [{"message": {"content": "not-json"}}],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, 1)
        if "anthropic" in url:
            return ({"content": [{"type": "text", "text": json.dumps({
                "weaknesses": [{"weakness": "single point of failure", "severity": "high"}]
            })}],
                     "usage": {"input_tokens": 100, "output_tokens": 50}}, 1)
        return ({}, 1)
    srv._http_post_resilient = parse_fail_post

    res = srv.tool_critique({
        "proposal":  "Add a global rate limit at 100 rps.",
        "providers": ["openai", "anthropic"],
    })
    statuses = {p["provider"]: p["status"] for p in res["per_provider"]}
    assert statuses == {"openai": "parse_error", "anthropic": "ok"}, statuses
    # The good panelist's weakness is still in the merged list.
    assert len(res["weaknesses"]) == 1
    assert res["weaknesses"][0]["provider"] == "anthropic"

    print("OK: test_explain_critique")
    return 0


if __name__ == "__main__":
    sys.exit(main())
