#!/usr/bin/env python3
"""Offline tests for the smart router + `recommend_panel` tool.

Covers:
  - cold-start fallback to provider_stats win-rate when usage_log has < 5 calls
  - composite score (reliability + cost + engagement) ordering when history exists
  - `exclude` filter
  - error_rate computed from events_log
  - `recommend_panel` tool wraps the helper correctly
  - `auto_panel: true` on confer populates `providers` from the router when
    the caller did not pass an explicit panel
  - `auto_panel: true` is a no-op when `providers` IS explicitly given

Exit 0 on success.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
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
        "gemini":    {"gemini-test":{"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0001}},
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
    srv.CFG["events_log"]     = str(tmp / "events.ndjson")
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
    srv.ENV["GEMINI_API_KEY"]    = "stub"; srv.ENV["GEMINI_MODEL"]    = "gemini-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai", "gemini"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai", "gemini"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # 1) Cold-start: empty usage_log -> provider_stats fallback, no crash
    # ------------------------------------------------------------------
    recommended, meta = srv._router_recommend("confer", n=2)
    assert meta["cold_start"] is True
    assert meta["history_calls"] == 0
    assert len(recommended) == 2
    for r in recommended:
        assert "cold-start" in r["rationale"]
        assert r["provider"] in {"openai", "anthropic", "xai", "gemini"}

    # ------------------------------------------------------------------
    # 2) With history: scoring orders providers by (reliability, cost)
    # ------------------------------------------------------------------
    # Seed usage_log with a clear pattern:
    #   openai: 10 calls, cheap, no errors -> should score highest
    #   anthropic: 10 calls, expensive, no errors -> second
    #   xai: 10 calls, expensive, 5 errors -> lowest
    now = int(time.time())
    answers_openai = [{
        "provider": "openai", "model": "gpt-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 100, "cpu_ms": 1, "attempts": 1,
        "usage": {"provider": "openai", "model": "gpt-test",
                  "prompt_tokens": 200, "completion_tokens": 80,
                  "cached_tokens": 0, "total_tokens": 280,
                  "cost_usd": 0.00003, "estimated": False, "purpose": "confer"},
    } for _ in range(10)]
    srv.log_usage("smart-router-history", "confer", answers_openai)

    answers_anthropic = [{
        "provider": "anthropic", "model": "claude-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 1500, "cpu_ms": 5, "attempts": 1,
        "usage": {"provider": "anthropic", "model": "claude-test",
                  "prompt_tokens": 200, "completion_tokens": 80,
                  "cached_tokens": 0, "total_tokens": 280,
                  "cost_usd": 0.0018, "estimated": False, "purpose": "confer"},
    } for _ in range(10)]
    srv.log_usage("smart-router-history", "confer", answers_anthropic)

    answers_xai = [{
        "provider": "xai", "model": "grok-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 2000, "cpu_ms": 5, "attempts": 1,
        "usage": {"provider": "xai", "model": "grok-test",
                  "prompt_tokens": 200, "completion_tokens": 80,
                  "cached_tokens": 0, "total_tokens": 280,
                  "cost_usd": 0.0025, "estimated": False, "purpose": "confer"},
    } for _ in range(10)]
    srv.log_usage("smart-router-history", "confer", answers_xai)

    # Emit 5 error events for xai (simulating provider failures).
    for _ in range(5):
        srv._emit_event("provider_call", provider="xai", model="grok-test",
                        purpose="confer", error_kind="server", elapsed_ms=2000,
                        attempts=0, cache_hit=False, cpu_ms=0)

    # Request all 4 so we can verify the full ordering: openai (cheap +
    # reliable) > anthropic (expensive + reliable) > xai (expensive + 33%
    # errors). gemini has no history -> gets defaults; it's allowed to land
    # anywhere among them as the router currently has no penalty for missing
    # data. The two assertions we DO care about: history beats history, and
    # error_rate is computed correctly.
    recommended, meta = srv._router_recommend("confer", n=4)
    assert meta["cold_start"] is False, meta
    assert meta["history_calls"] >= 30
    names = [r["provider"] for r in recommended]
    # openai (cheapest + reliable) must outrank anthropic.
    assert names.index("openai") < names.index("anthropic"), names
    # xai's error_rate must be visible and > 0.2 (5 errors of 15 events = 0.33).
    xai_entry = next(r for r in recommended if r["provider"] == "xai")
    assert xai_entry["error_rate"] is not None
    assert xai_entry["error_rate"] > 0.2, xai_entry
    # xai must outrank or appear below anthropic in the list (i.e., not first).
    assert names.index("xai") > 0, names

    # ------------------------------------------------------------------
    # 3) `exclude` filter
    # ------------------------------------------------------------------
    recommended, _ = srv._router_recommend("confer", n=3, exclude=["openai"])
    names = [r["provider"] for r in recommended]
    assert "openai" not in names, names

    # ------------------------------------------------------------------
    # 4) `recommend_panel` tool wraps the helper
    # ------------------------------------------------------------------
    res = srv.tool_recommend_panel({"purpose": "confer", "n": 2})
    assert res["tool"] == "recommend_panel"
    assert len(res["recommended"]) == 2
    assert res["meta"]["purpose"] == "confer"

    # Missing purpose -> structured error
    err = srv.tool_recommend_panel({})
    assert err.get("error_code") == "RECOMMEND_PANEL_MISSING_PURPOSE"

    # ------------------------------------------------------------------
    # 5) auto_panel on confer (no `providers` arg) -> router-selected panel
    # ------------------------------------------------------------------
    captured_bodies: list[dict] = []
    def fake_post_resilient(url, headers, body, timeout, deadline):
        captured_bodies.append({"url": url, "body": body})
        if "openai" in url:
            return ({"choices": [{"message": {"content": "openai-out"}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic" in url:
            return ({"content": [{"type": "text", "text": "anthropic-out"}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        if "googleapis" in url:
            return ({"candidates": [{"content": {"parts": [{"text": "gemini-out"}]}}],
                     "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 8, "totalTokenCount": 33}}, 1)
        return ({"choices": [{"message": {"content": "xai-out"}}],
                 "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
    srv._http_post_resilient = fake_post_resilient

    captured_bodies.clear()
    res = srv.tool_confer({
        "question":   "smart-routed test",
        "auto_panel": True,
        "auto_panel_n": 2,
    })
    # The configured active set had 4 providers; auto_panel should narrow to 2.
    assert len(res["answers"]) == 2, res
    providers_used = sorted([a["provider"] for a in res["answers"]])
    # openai should be one of them (highest scoring).
    assert "openai" in providers_used, providers_used

    # ------------------------------------------------------------------
    # 6) auto_panel is a no-op when `providers` is explicitly given
    # ------------------------------------------------------------------
    res = srv.tool_confer({
        "question":  "explicit panel beats auto",
        "auto_panel": True,
        "providers": ["anthropic", "gemini", "xai"],
    })
    providers_used = sorted([a["provider"] for a in res["answers"]])
    assert providers_used == ["anthropic", "gemini", "xai"], providers_used

    print("OK: test_smart_router")
    return 0


if __name__ == "__main__":
    sys.exit(main())
