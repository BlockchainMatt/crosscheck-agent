#!/usr/bin/env python3
"""Offline tests for the Week-1 usage / pricing / timing / progress surface.

Covers:
  - Pricing loader (default path + env override + missing file fallback)
  - _calculate_cost() known + unknown model
  - SendResult tuple-unpack backward compat
  - Usage.with_cost() round-trip + _aggregate_usage rollup
  - SQLite migration: usage_log table + sessions token/cost columns
  - log_usage() writes rows + _session_record accumulates
  - _attach_usage_block() shape on tool result
  - _emit_progress() writes a stderr line and a notifications/progress
    JSON-RPC message when a progressToken is bound
  - openai/anthropic/gemini provider adapters parse native usage shapes

No network calls. Stubs `_http_post` end-to-end.

Exit 0 on success.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
from pathlib import Path


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    # Point pricing + DB at temp paths BEFORE import so module-level defaults
    # pick them up.
    tmp = Path(tempfile.mkdtemp())
    pricing_file = tmp / "pricing.json"
    pricing_file.write_text(json.dumps({
        "anthropic": {
            "claude-test-pro": {"prompt_per_1k": 0.01, "completion_per_1k": 0.03,
                                "cached_per_1k": 0.001},
        },
        "openai": {
            "gpt-test":      {"prompt_per_1k": 0.001, "completion_per_1k": 0.002,
                               "cached_per_1k": 0.0005},
        },
        "_tiers": {
            "low":  {"models": [{"provider": "openai", "model": "gpt-test"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test-pro"}]},
            "high": {"models": []},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing_file)

    import crosscheck_server as srv

    # Use a temp SQLite DB for log_usage / session tests.
    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"] = str(tmp / "sessions.db")
    srv._DB_INIT_DONE = False  # force re-init against new path

    # -----------------------------------------------------------------
    # 1) Pricing loader: env override picked up, contents parse
    # -----------------------------------------------------------------
    srv._PRICING_CACHE = None  # force reload from env-pointed file
    srv.PRICING_PATH = Path(os.environ["CROSSCHECK_PRICING_PATH"])
    data = srv._load_pricing()
    assert "anthropic" in data and "claude-test-pro" in data["anthropic"], "pricing not loaded"
    tiers = srv._tier_ladder()
    assert set(tiers.keys()) == {"low", "med", "high"}, f"tier keys wrong: {tiers.keys()}"
    assert tiers["low"][0]["model"] == "gpt-test"

    # -----------------------------------------------------------------
    # 2) Cost calculation
    # -----------------------------------------------------------------
    cost, est = srv._calculate_cost("anthropic", "claude-test-pro",
                                    prompt_tokens=1000, completion_tokens=500)
    # 1000/1000 * 0.01 + 500/1000 * 0.03 = 0.01 + 0.015 = 0.025
    assert abs(cost - 0.025) < 1e-9 and not est, f"cost wrong: {cost} est={est}"

    cost, est = srv._calculate_cost("openai", "no-such-model", 100, 100)
    assert cost == 0.0 and est is True, "unknown model should be cost=0 estimated=true"

    # Cached tokens are discounted, not double-counted.
    cost, est = srv._calculate_cost("anthropic", "claude-test-pro",
                                    prompt_tokens=1000, completion_tokens=0,
                                    cached_tokens=400)
    # 600 fresh prompt @ 0.01 + 400 cached @ 0.001 = 0.006 + 0.0004 = 0.0064
    assert abs(cost - 0.0064) < 1e-9 and not est, f"cached cost wrong: {cost}"

    # -----------------------------------------------------------------
    # 3) Missing pricing file -> empty dict (no crash)
    # -----------------------------------------------------------------
    srv._PRICING_CACHE = None
    srv.PRICING_PATH = Path(tmp / "missing.json")
    assert srv._load_pricing() == {}
    cost, est = srv._calculate_cost("anthropic", "claude-test-pro", 100, 100)
    assert cost == 0.0 and est is True, "missing pricing file should still degrade gracefully"

    # Restore good pricing for the rest of the suite.
    srv._PRICING_CACHE = None
    srv.PRICING_PATH = pricing_file

    # -----------------------------------------------------------------
    # 4) SendResult tuple-unpack backward compatibility
    # -----------------------------------------------------------------
    sr = srv.SendResult(text="hello", attempts=2, usage=None)
    text, attempts = sr
    assert text == "hello" and attempts == 2, "SendResult tuple-unpack broken"

    # -----------------------------------------------------------------
    # 5) Usage.with_cost + aggregator
    # -----------------------------------------------------------------
    u1 = srv.Usage(provider="anthropic", model="claude-test-pro",
                   prompt_tokens=1000, completion_tokens=500,
                   purpose="confer").with_cost()
    assert abs(u1.cost_usd - 0.025) < 1e-9 and not u1.estimated

    u2 = srv.Usage(provider="openai", model="gpt-test",
                   prompt_tokens=2000, completion_tokens=100,
                   purpose="confer").with_cost()
    # 2000/1000 * 0.001 + 100/1000 * 0.002 = 0.002 + 0.0002 = 0.0022
    assert abs(u2.cost_usd - 0.0022) < 1e-9, f"u2.cost_usd = {u2.cost_usd}"

    agg = srv._aggregate_usage([u1, u2])
    assert agg["totals"]["total_tokens"] == 1500 + 2100, agg["totals"]
    assert abs(agg["totals"]["cost_usd"] - (0.025 + 0.0022)) < 1e-9
    assert len(agg["by_provider"]) == 2
    assert {p["provider"] for p in agg["by_provider"]} == {"anthropic", "openai"}

    # -----------------------------------------------------------------
    # 6) DB migration: usage_log + sessions columns
    # -----------------------------------------------------------------
    srv._db_init()
    with srv._db_conn() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        for need in ("total_prompt_tokens", "total_completion_tokens",
                     "total_cached_tokens", "total_tokens",
                     "total_cost_usd", "total_cpu_ms"):
            assert need in cols, f"sessions column missing: {need}"
        tabs = {r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "usage_log" in tabs, "usage_log table missing"

    # Idempotent: re-running _db_init must not raise.
    srv._DB_INIT_DONE = False
    srv._db_init()

    # -----------------------------------------------------------------
    # 7) _session_record + log_usage + persistence
    # -----------------------------------------------------------------
    sess = srv._session_load("test_usage_session")
    assert sess["total_tokens"] == 0 and sess["total_cost_usd"] == 0.0

    answers = [
        {"provider": "anthropic", "model": "claude-test-pro",
         "response": "ok", "cache_hit": False,
         "elapsed_ms": 120, "cpu_ms": 4, "attempts": 1,
         "usage": u1.to_dict()},
        {"provider": "openai", "model": "gpt-test",
         "response": "ok", "cache_hit": False,
         "elapsed_ms": 80,  "cpu_ms": 2, "attempts": 1,
         "usage": u2.to_dict()},
    ]
    srv._session_record(sess, answers, 0.0, 0.0)
    assert sess["calls"] == 2 and sess["total_tokens"] == 3600, sess
    assert abs(sess["total_cost_usd"] - (0.025 + 0.0022)) < 1e-9
    srv._session_save(sess)
    srv.log_usage("test_usage_session", "confer", answers)

    with srv._db_conn() as conn:
        n, total_tok, total_cost = conn.execute(
            "SELECT COUNT(*), SUM(total_tokens), SUM(cost_usd) FROM usage_log "
            "WHERE session_id = ?", ("test_usage_session",)).fetchone()
        assert n == 2 and total_tok == 3600 and abs(total_cost - 0.0272) < 1e-9, \
            (n, total_tok, total_cost)
        row = conn.execute(
            "SELECT total_tokens, total_cost_usd FROM sessions WHERE session_id = ?",
            ("test_usage_session",)).fetchone()
        assert row["total_tokens"] == 3600 and abs(row["total_cost_usd"] - 0.0272) < 1e-9

    # log_usage must never raise on missing session_id.
    srv.log_usage(None, "confer", answers)
    srv.log_usage("", "confer", [])

    # -----------------------------------------------------------------
    # 8) _attach_usage_block shape
    # -----------------------------------------------------------------
    result: dict = {"tool": "confer", "answers": answers}
    srv._attach_usage_block(result, answers)
    assert "usage" in result and "timing" in result, "missing usage/timing"
    assert result["usage"]["totals"]["calls"] == 2
    assert result["timing"]["wall_ms"] == 200 and result["timing"]["cpu_ms"] == 6
    assert len(result["timing"]["by_call"]) == 2
    assert {c["purpose"] for c in result["timing"]["by_call"]} == {"confer"}

    # -----------------------------------------------------------------
    # 9) _emit_progress: stderr + notifications/progress on bound token
    # -----------------------------------------------------------------
    captured: list[str] = []
    srv._STDOUT_WRITER = captured.append
    old_stderr = sys.stderr
    sys.stderr = io.StringIO()
    try:
        srv._progress_set("ptoken-test")
        srv._emit_progress("step1: hi", provider="openai", model="gpt-test")
        srv._emit_progress("step2: done")
    finally:
        srv._progress_clear()
        stderr_out = sys.stderr.getvalue()
        sys.stderr = old_stderr
        srv._STDOUT_WRITER = None
    assert "step1" in stderr_out and "step2" in stderr_out, stderr_out
    # Two progress notifications should have been written to stdout.
    notifs = [json.loads(c) for c in captured if c.strip()]
    assert len(notifs) == 2, captured
    assert all(n.get("method") == "notifications/progress" for n in notifs), notifs
    assert notifs[0]["params"]["progressToken"] == "ptoken-test"
    assert notifs[0]["params"]["message"].startswith("step1")

    # Progress with no bound token -> stderr only, no stdout.
    captured.clear()
    sys.stderr = io.StringIO()
    try:
        srv._STDOUT_WRITER = captured.append
        srv._emit_progress("orphan: should only appear in stderr")
    finally:
        sys.stderr = old_stderr
        srv._STDOUT_WRITER = None
    assert captured == [], f"unexpected stdout: {captured}"

    # -----------------------------------------------------------------
    # 10) Provider adapter usage parsing (OpenAI / Anthropic / Gemini)
    # -----------------------------------------------------------------
    # Patch low-level HTTP so adapters can run without network.
    captured_url: dict = {}
    def fake_post(url, headers, body, timeout):
        captured_url["url"] = url
        if "api.openai.com" in url or "x.ai" in url or "groq.com" in url \
                or "mistral.ai" in url or "deepseek.com" in url:
            return {
                "choices": [{"message": {"content": "openai-reply"}}],
                "usage": {
                    "prompt_tokens": 200, "completion_tokens": 50, "total_tokens": 250,
                    "prompt_tokens_details": {"cached_tokens": 40},
                },
            }
        if "api.anthropic.com" in url:
            return {
                "content": [{"type": "text", "text": "anthropic-reply"}],
                "usage": {"input_tokens": 160, "output_tokens": 30,
                          "cache_read_input_tokens": 40},
            }
        if "googleapis.com" in url:
            return {
                "candidates": [{"content": {"parts": [{"text": "gemini-reply"}]}}],
                "usageMetadata": {"promptTokenCount": 220, "candidatesTokenCount": 60,
                                  "cachedContentTokenCount": 20,
                                  "totalTokenCount": 300},
            }
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        return fake_post(url, headers, body, timeout), 1

    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # Fabricate Provider instances using the existing factories so the test
    # uses the real adapter parsing code paths.
    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"] = "test"
    srv.ENV["OPENAI_MODEL"] = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "test"
    srv.ENV["ANTHROPIC_MODEL"] = "claude-test-pro"
    srv.ENV["GEMINI_API_KEY"] = "test"
    srv.ENV["GEMINI_MODEL"] = "gemini-test"
    # gemini-test isn't priced; will be estimated=false on the API usage but
    # estimated=true on cost. That's fine.

    op = srv.openai_compatible("openai", "https://api.openai.com/v1/chat/completions",
                               "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-test")
    an = srv.anthropic_provider()
    ge = srv.gemini_provider()
    assert op and an and ge, "adapters didn't build"

    r_op = op.send([{"role": "user", "content": "hi"}], 256, 0.4, purpose="confer")
    assert r_op.usage and r_op.usage.prompt_tokens == 200, r_op.usage
    assert r_op.usage.completion_tokens == 50
    assert r_op.usage.cached_tokens == 40
    assert r_op.usage.purpose == "confer"
    # Cost: 160 fresh prompt + 40 cached + 50 completion
    # 160/1000*0.001 + 40/1000*0.0005 + 50/1000*0.002 = 0.00016 + 0.00002 + 0.0001 = 0.00028
    assert abs(r_op.usage.cost_usd - 0.00028) < 1e-9, r_op.usage.cost_usd

    r_an = an.send([{"role": "user", "content": "hi"}], 256, 0.4, purpose="debate")
    # Anthropic: input_tokens=160 + cache_read=40 -> prompt=200 with cached=40
    assert r_an.usage.prompt_tokens == 200 and r_an.usage.cached_tokens == 40
    assert r_an.usage.completion_tokens == 30
    assert r_an.usage.purpose == "debate"

    r_ge = ge.send([{"role": "user", "content": "hi"}], 256, 0.4, purpose="plan")
    assert r_ge.usage.prompt_tokens == 220 and r_ge.usage.cached_tokens == 20
    assert r_ge.usage.completion_tokens == 60
    assert r_ge.usage.purpose == "plan"

    print("OK: test_usage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
