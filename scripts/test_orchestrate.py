#!/usr/bin/env python3
"""Offline tests for `orchestrate`, the cheap-mode router, and `audit`.

Stubs all provider `send()` calls so the tests run without network. Covers:
  - _validate_dag: missing id, duplicate id, unknown dep, cycle, bad difficulty
  - tool_orchestrate with a pre-authored DAG (skips planning round)
  - DAG partial-recombine default: one node fails -> final has [MISSING:] markers
  - fail_fast=True: prior node failure skips downstream nodes
  - cheap-mode picks low-tier model for difficulty=low when cheap_mode=true
  - audit: rejects when auditor is in the producing panel
  - audit: default rubric path, structured response shape
  - audit: usage tagged purpose='audit' and rolled up in session totals

Exit 0 on success.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp())
    pricing_file = tmp / "pricing.json"
    pricing_file.write_text(json.dumps({
        "openai":    {"gpt-test-low": {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test-mid": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test-high": {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test-low"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test-mid"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test-high"}]},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing_file)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"] = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"] = {"enabled": False}  # bypass disk cache for deterministic stubs
    srv.TRANSCRIPT_DIR = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE = False
    srv._PRICING_CACHE = None
    srv.PRICING_PATH = pricing_file
    srv.ENV = dict(srv.ENV)

    # Stub the three providers with their factory functions so the real
    # send() shells exist; then monkeypatch the HTTP layer.
    srv.ENV["OPENAI_API_KEY"] = "stub"
    srv.ENV["OPENAI_MODEL"] = "gpt-test-low"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"
    srv.ENV["ANTHROPIC_MODEL"] = "claude-test-mid"
    srv.ENV["XAI_API_KEY"] = "stub"
    srv.ENV["XAI_MODEL"] = "grok-test-high"
    # Build only the providers under test; prune anything else the developer's
    # local .env happened to register so the cheap-mode router can run out of
    # options for the "no auditor" path.
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    call_log: list[dict] = []

    def fake_post(url, headers, body, timeout):
        if "openai.com" in url or "x.ai" in url:
            text = "openai-output" if "openai" in url else "xai-output"
            return {
                "choices": [{"message": {"content": text}}],
                "usage": {"prompt_tokens": 80, "completion_tokens": 20, "total_tokens": 100},
            }
        if "anthropic.com" in url:
            return {
                "content": [{"type": "text", "text": "anthropic-output"}],
                "usage": {"input_tokens": 60, "output_tokens": 25},
            }
        if "googleapis.com" in url:
            return {
                "candidates": [{"content": {"parts": [{"text": "gemini-output"}]}}],
                "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10,
                                  "totalTokenCount": 60},
            }
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        call_log.append({"url": url, "body": body})
        return fake_post(url, headers, body, timeout), 1

    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # -----------------------------------------------------------------
    # 1) _validate_dag
    # -----------------------------------------------------------------
    bad = srv._validate_dag({"nodes": []})
    assert bad and "non-empty" in bad[0], bad

    bad = srv._validate_dag({"nodes": [{"id": "A", "task": "x", "difficulty": "low"},
                                       {"id": "A", "task": "y", "difficulty": "med"}]})
    assert any("duplicate" in e for e in bad), bad

    bad = srv._validate_dag({"nodes": [{"id": "A", "task": "", "difficulty": "low"}]})
    assert any("missing 'task'" in e for e in bad), bad

    bad = srv._validate_dag({"nodes": [
        {"id": "A", "task": "x", "difficulty": "low", "depends_on": ["nope"]},
    ]})
    assert any("unknown dep" in e for e in bad), bad

    bad = srv._validate_dag({"nodes": [{"id": "A", "task": "x", "difficulty": "weird"}]})
    assert any("difficulty must be" in e for e in bad), bad

    cycle = srv._validate_dag({"nodes": [
        {"id": "A", "task": "x", "difficulty": "low", "depends_on": ["B"]},
        {"id": "B", "task": "y", "difficulty": "low", "depends_on": ["A"]},
    ]})
    assert any("cycle" in e for e in cycle), cycle

    ok = srv._validate_dag({"nodes": [
        {"id": "A", "task": "x", "difficulty": "low"},
        {"id": "B", "task": "y", "difficulty": "med", "depends_on": ["A"]},
    ]})
    assert ok == [], ok

    # -----------------------------------------------------------------
    # 2) Cheap-mode router picks correct tier
    # -----------------------------------------------------------------
    prov, model, reason = srv._select_for_difficulty("low", allow_only=["openai", "anthropic", "xai"])
    assert prov is not None and prov.name == "openai" and model == "gpt-test-low", \
        (prov, model, reason)
    prov, model, _ = srv._select_for_difficulty("med", allow_only=["openai", "anthropic", "xai"])
    assert prov is not None and prov.name == "anthropic" and model == "claude-test-mid"
    prov, model, _ = srv._select_for_difficulty("high", allow_only=["openai", "anthropic", "xai"])
    assert prov is not None and prov.name == "xai" and model == "grok-test-high"

    # Exclusion forces fallback (low tier only has openai; excluding it -> None).
    prov, model, reason = srv._select_for_difficulty("low", exclude_providers=["openai"],
                                                    allow_only=["openai", "anthropic", "xai"])
    assert prov is None and reason and "no available provider" in reason, (prov, reason)

    # -----------------------------------------------------------------
    # 3) tool_orchestrate with pre-authored DAG (skips planner)
    # -----------------------------------------------------------------
    call_log.clear()
    dag = {
        "summary": "tiny test dag",
        "nodes": [
            {"id": "fetch", "task": "Pull the issue title.", "difficulty": "low"},
            {"id": "draft", "task": "Draft a fix proposal.",  "difficulty": "med",
             "depends_on": ["fetch"]},
        ],
    }
    res = srv.tool_orchestrate({
        "dag": dag, "session_id": "orch-test-1", "cheap_mode": True,
        "providers": ["openai", "anthropic", "xai"],
    })
    assert res.get("tool") == "orchestrate" and "error" not in res, res
    assert not res["partial"] and res["missing"] == [], res
    node_status = {n["id"]: n["status"] for n in res["nodes"]}
    assert node_status == {"fetch": "ok", "draft": "ok"}, node_status
    # Cheap-mode: fetch (low) should run on openai, draft (med) on anthropic.
    node_by_id = {n["id"]: n for n in res["nodes"]}
    assert node_by_id["fetch"]["provider"] == "openai", node_by_id["fetch"]
    assert node_by_id["draft"]["provider"] == "anthropic", node_by_id["draft"]
    # usage + timing blocks present and populated.
    assert res["usage"]["totals"]["calls"] >= 3, res["usage"]  # 2 workers + synth
    assert res["timing"]["wall_ms"] >= 0
    assert res["budget"]["total_cost_usd"] > 0
    # Final text non-empty (anthropic synth produced a string).
    assert res["final"] and isinstance(res["final"], str), res["final"]

    # -----------------------------------------------------------------
    # 4) Partial-recombine: one node fails -> [MISSING:] marker propagates
    # -----------------------------------------------------------------
    # Force one provider to error by wrapping fake_post_resilient.
    def flaky(url, headers, body, timeout, deadline):
        call_log.append({"url": url, "body": body})
        if "openai.com" in url:
            raise srv.ProviderError("server", "fake 500", status=500, transient=False)
        return fake_post(url, headers, body, timeout), 1

    srv._http_post_resilient = flaky
    res2 = srv.tool_orchestrate({
        "dag": dag, "session_id": "orch-test-2", "cheap_mode": True,
        "providers": ["openai", "anthropic", "xai"],
    })
    assert res2["partial"] is True, res2
    assert "fetch" in res2["missing"], res2
    node_status = {n["id"]: n["status"] for n in res2["nodes"]}
    assert node_status["fetch"] == "failed"
    # Draft still runs (partial-recombine default).
    assert node_status["draft"] == "ok", node_status

    # -----------------------------------------------------------------
    # 5) fail_fast: failed upstream -> downstream skipped, not run
    # -----------------------------------------------------------------
    res3 = srv.tool_orchestrate({
        "dag": dag, "session_id": "orch-test-3", "cheap_mode": True,
        "providers": ["openai", "anthropic", "xai"], "fail_fast": True,
    })
    node_status = {n["id"]: n["status"] for n in res3["nodes"]}
    assert node_status["fetch"] == "failed"
    assert node_status["draft"] in ("skipped", "not_run"), node_status

    # Restore happy path.
    srv._http_post_resilient = fake_post_resilient

    # -----------------------------------------------------------------
    # 6) audit: auto-coalesces when every provider is on the producing panel
    # (no single auditor exists). Mode should be "coalesced_self", with the
    # transparency flag set; never returns a "no auditor" error anymore.
    # -----------------------------------------------------------------
    a_block = srv.tool_audit({
        "output_to_audit": "test output",
        "producing_panelists": ["openai", "anthropic", "xai"],
        "cheap_mode": True,
    })
    assert "error" not in a_block, a_block.get("error")
    assert a_block.get("mode") == "coalesced_self", a_block.get("mode")
    assert len(a_block.get("judges", [])) >= 2

    # -----------------------------------------------------------------
    # 7) audit: structured rubric scoring with auditor selected outside panel
    # -----------------------------------------------------------------
    # Have auditor (anthropic) return JSON matching the schema.
    def audit_post(url, headers, body, timeout):
        if "anthropic.com" in url:
            obj = {
                "items": [
                    {"id": rid, "score": 0.9, "pass": True,
                     "rationale": f"audit:{rid}"}
                    for rid in [r["id"] for r in srv.DEFAULT_AUDIT_RUBRICS]
                ],
                "overall_score": 0.9,
            }
            return {"content": [{"type": "text", "text": json.dumps(obj)}],
                    "usage": {"input_tokens": 200, "output_tokens": 80}}
        return fake_post(url, headers, body, timeout)

    def audit_post_resilient(url, headers, body, timeout, deadline):
        return audit_post(url, headers, body, timeout), 1

    srv._http_post_resilient = audit_post_resilient

    aud = srv.tool_audit({
        "output_to_audit": "Some output we want to grade.",
        "producing_panelists": ["openai", "xai"],
        "cheap_mode": False,  # falls through to configured moderator (anthropic)
        "session_id": "audit-test-1",
    })
    assert aud.get("tool") == "audit" and "error" not in aud, aud
    assert aud["auditor"]["provider"] == "anthropic"
    assert aud["overall_score"] == 0.9
    assert aud["passed"] is True
    assert len(aud["items"]) == len(srv.DEFAULT_AUDIT_RUBRICS)
    # usage purpose='audit'
    purposes = [c["purpose"] for c in aud["usage"]["by_call"]]
    assert "audit" in purposes, purposes
    # Session totals include the audit call.
    with srv._db_conn() as conn:
        row = conn.execute("SELECT total_tokens, total_cost_usd FROM sessions "
                           "WHERE session_id = ?", ("audit-test-1",)).fetchone()
        assert row["total_tokens"] > 0 and row["total_cost_usd"] >= 0.0, dict(row)
        # usage_log row with purpose='audit'
        n = conn.execute("SELECT COUNT(*) FROM usage_log WHERE session_id = ? AND purpose = 'audit'",
                         ("audit-test-1",)).fetchone()[0]
        assert n == 1, n

    # -----------------------------------------------------------------
    # 8) audit: explicit-auditor on producing panel rejected
    # -----------------------------------------------------------------
    bad = srv.tool_audit({
        "output_to_audit": "x",
        "producing_panelists": ["anthropic"],
        "auditor": "anthropic",
    })
    assert "error" in bad and "producing panel" in bad["error"], bad

    # -----------------------------------------------------------------
    # 9) audit: allow_self_audit bypass
    # -----------------------------------------------------------------
    ok = srv.tool_audit({
        "output_to_audit": "x",
        "producing_panelists": ["anthropic"],
        "auditor": "anthropic",
        "allow_self_audit": True,
    })
    assert ok.get("tool") == "audit" and "error" not in ok, ok

    print("OK: test_orchestrate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
