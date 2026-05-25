#!/usr/bin/env python3
"""Tests for the polish batch (A + B + C + D + E + H)."""

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
        "openai":    {"gpt-test":   {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005},
                       "gpt-5":      {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0005}},
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
    srv.CFG["node_cache"]     = {"enabled": False}
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
    # C) model-tier-aware budgets
    # ------------------------------------------------------------------
    # gpt-test is NOT a reasoning model (doesn't start with gpt-5/o*)
    # gpt-5 IS a reasoning model
    # claude-test is NOT a reasoning model (claude-opus-4-7+ is)
    assert srv._is_reasoning_model("openai", "gpt-test")  is False
    assert srv._is_reasoning_model("openai", "gpt-5")     is True
    assert srv._is_reasoning_model("openai", "gpt-5-pro") is True
    assert srv._is_reasoning_model("anthropic", "claude-opus-4-7") is True
    assert srv._is_reasoning_model("anthropic", "claude-test")     is False
    # Budget defaults: reasoning gets 2048 across the board, non-reasoning
    # gets the smaller per-purpose ceilings.
    assert srv._budget_for_purpose("audit") == 2048   # no model -> reasoning-safe
    assert srv._budget_for_purpose("audit", "openai", "gpt-5")    == 2048   # reasoning
    assert srv._budget_for_purpose("audit", "openai", "gpt-test") == 768    # non-reasoning
    assert srv._budget_for_purpose("synth", "openai", "gpt-test") == 1024
    assert srv._budget_for_purpose("worker","openai", "gpt-test") == 2048   # workers always need room
    # Explicit override via CFG wins regardless of model class.
    srv.CFG["token_budgets"] = {"audit": 300}
    assert srv._budget_for_purpose("audit", "openai", "gpt-test") == 300
    assert srv._budget_for_purpose("audit", "openai", "gpt-5")    == 300
    srv.CFG["token_budgets"] = {}

    # ------------------------------------------------------------------
    # A) Canary in coordinate
    # ------------------------------------------------------------------
    # Make openai (used as a critic) echo the canary; coordinate should flag.
    state = {"agreement": {"agreed": True, "confidence": 0.9, "summary": "agreed"}}

    def _is_audit_judge(body):
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        if isinstance(body.get("system"), str): parts.append(body["system"])
        return "agreement checker" in "\n".join(parts)

    import re as _re
    def _find_canary(body):
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        if isinstance(body.get("system"), str): parts.append(body["system"])
        m = _re.search(r"CC_CANARY_[A-F0-9]+", "\n".join(parts))
        return m.group(0) if m else ""

    def _all_text(body):
        return "\n".join(m.get("content", "") for m in body.get("messages") or []
                          if isinstance(m, dict))
        # system content is included as a message for OpenAI; Anthropic puts it in body["system"]

    def _role_from_body(body):
        full = _all_text(body)
        if isinstance(body.get("system"), str):
            full += "\n" + body["system"]
        full_lower = full.lower()
        if "you are the synthesizer" in full_lower:
            return "synthesizer"
        if "you are the proposer" in full_lower:
            return "proposer"
        if "you are a critic" in full_lower:
            return "critic"
        return "critic"

    def fake_post(url, headers, body, timeout):
        canary = _find_canary(body)
        role = _role_from_body(body)
        if role == "synthesizer":
            obj = {"consensus": "agreed", "weighted_confidence": 0.9,
                   "key_claims": []}
        elif role == "proposer":
            obj = {"role": "proposer", "summary": "draft position",
                   "confidence": 0.8, "ballot": "agree"}
        else:
            obj = {"role": "critic", "summary": "looks fine",
                   "confidence": 0.7, "ballot": "agree"}

        if "openai.com" in url:
            text = json.dumps(obj)
            if canary and "openai-echoes" not in state:
                text = json.dumps(obj) + f"\nleak: {canary}"
                state["openai-echoes"] = True
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            return ({"content": [{"type": "text", "text": json.dumps(obj)}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        if "x.ai" in url:
            return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({}, 1)

    srv._http_post_resilient = lambda url, h, b, **kw: fake_post(url, h, b, kw.get("timeout", 30))

    state.clear()
    state["agreement"] = {"agreed": True, "confidence": 0.9, "summary": "agreed"}
    res = srv.tool_coordinate({
        "topic":           "test the canary",
        "context":         "untrusted user-supplied data goes here",
        "providers":       ["openai", "anthropic", "xai"],
        "proposer":        "anthropic",
        "critics":         ["openai", "xai"],
        "synthesizer":     "anthropic",
        "untrusted_input": True,
    })
    assert res.get("canary_leaks"), f"expected canary_leaks: {res}"
    leak_providers = {l["provider"] for l in res["canary_leaks"]}
    assert "openai" in leak_providers, leak_providers
    # openai's critique answer must have the canary redacted.
    openai_ans = next(a for a in res["critique_answers"]
                       if isinstance(a, dict) and a.get("provider") == "openai")
    assert "CC_CANARY_" not in (openai_ans.get("response") or ""), openai_ans

    # Without untrusted_input, no canary minted.
    res = srv.tool_coordinate({
        "topic":     "no canary here",
        "context":   "ordinary context, no untrusted flag",
        "providers": ["openai", "anthropic", "xai"],
        "proposer":  "anthropic", "critics": ["openai", "xai"],
        "synthesizer": "anthropic",
    })
    assert "canary_leaks" not in res

    # ------------------------------------------------------------------
    # A') Canary in critique
    # ------------------------------------------------------------------
    state.clear()
    def critique_post(url, headers, body, timeout):
        canary = _find_canary(body)
        if "openai.com" in url:
            text = json.dumps({"weaknesses": [
                {"weakness": "fails on bad inputs", "severity": "high"}
            ]})
            if canary:
                text = text[:-1] + f', "echoed_canary": "{canary}"' + "}"
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            return ({"content": [{"type": "text", "text": json.dumps({"weaknesses": [
                {"weakness": "naming inconsistent", "severity": "low"}
            ]})}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = lambda url, h, b, **kw: critique_post(url, h, b, kw.get("timeout", 30))

    res = srv.tool_critique({
        "proposal":        "Add a global rate limit at 100 rps",
        "providers":       ["openai", "anthropic"],
        "untrusted_input": True,
    })
    assert res.get("canary_leaks"), f"expected canary_leaks: {res}"
    assert any(l["provider"] == "openai" for l in res["canary_leaks"])

    # ------------------------------------------------------------------
    # B) verify attaches run_summary
    # ------------------------------------------------------------------
    res = srv.tool_verify({"checks": [
        {"kind": "contains", "id": "ok", "target_text": "hello", "value": "hello"},
    ]})
    assert "run_summary" in res, res
    assert res["run_summary"]["tool"] == "verify"

    # ------------------------------------------------------------------
    # D) pick early-stop
    # ------------------------------------------------------------------
    state.clear()
    def pick_post(url, headers, body, timeout):
        # Each provider scores both options; phase-1 providers (openai, anthropic)
        # agree that option_A is the top with overall 0.85; phase-2 should be skipped.
        if "openai.com" in url or "anthropic.com" in url:
            obj = {"scores": [
                {"option": "alpha", "overall": 0.85, "by_criterion": [
                    {"criterion": "cost", "score": 0.9, "rationale": "cheap"},
                ]},
                {"option": "beta",  "overall": 0.40, "by_criterion": [
                    {"criterion": "cost", "score": 0.5, "rationale": "ok"},
                ]},
            ]}
            text = json.dumps(obj)
            if "openai.com" in url:
                return ({"choices": [{"message": {"content": text}}],
                         "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
            return ({"content": [{"type": "text", "text": text}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        if "x.ai" in url:
            # Shouldn't be called when early-stop activates.
            state["xai_called"] = True
            obj = {"scores": []}
            return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = lambda url, h, b, **kw: pick_post(url, h, b, kw.get("timeout", 30))

    res = srv.tool_pick({
        "decision":    "which one to pick",
        "options":     ["alpha", "beta"],
        "criteria":    [{"name": "cost", "weight": 1.0}],
        "providers":   ["openai", "anthropic", "xai"],
        "early_stop":  True,
    })
    assert res.get("early_stopped") is True, res
    assert "xai" in res.get("skipped_providers", []), res
    assert state.get("xai_called") is not True, "xai must not be dispatched"
    assert res["agreement_check"]["agreed_option"] == "alpha"

    # Phase-1 disagreement -> full panel runs.
    state.clear()
    def pick_post_disagree(url, headers, body, timeout):
        if "openai.com" in url:
            obj = {"scores": [{"option": "alpha", "overall": 0.85, "by_criterion": []},
                              {"option": "beta",  "overall": 0.40, "by_criterion": []}]}
            return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            obj = {"scores": [{"option": "beta",  "overall": 0.80, "by_criterion": []},
                              {"option": "alpha", "overall": 0.50, "by_criterion": []}]}
            return ({"content": [{"type": "text", "text": json.dumps(obj)}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        if "x.ai" in url:
            state["xai_called"] = True
            obj = {"scores": [{"option": "alpha", "overall": 0.7, "by_criterion": []},
                              {"option": "beta",  "overall": 0.6, "by_criterion": []}]}
            return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = lambda url, h, b, **kw: pick_post_disagree(url, h, b, kw.get("timeout", 30))
    res = srv.tool_pick({
        "decision":    "disagreement test",
        "options":     ["alpha", "beta"],
        "criteria":    [{"name": "cost", "weight": 1.0}],
        "providers":   ["openai", "anthropic", "xai"],
        "early_stop":  True,
    })
    assert res.get("early_stopped") is False, res
    assert state.get("xai_called") is True

    # ------------------------------------------------------------------
    # E) Smart-router orders audit coalesce judges
    # ------------------------------------------------------------------
    # Seed usage_log so the router gives anthropic the best score for audit.
    # Bigger calls + zero errors → top of the recommendation list.
    seed_anthropic = [{
        "provider": "anthropic", "model": "claude-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 50, "cpu_ms": 1, "attempts": 1,
        "usage": {"provider": "anthropic", "model": "claude-test",
                  "prompt_tokens": 800, "completion_tokens": 400,
                  "cached_tokens": 0, "total_tokens": 1200,
                  "cost_usd": 0.001, "estimated": False, "purpose": "audit"},
    } for _ in range(10)]
    srv.log_usage("router-seed", "audit", seed_anthropic)
    # xai gets several error events
    for _ in range(8):
        srv._emit_event("provider_call", provider="xai", model="grok-test",
                        purpose="audit", error_kind="server", elapsed_ms=2000,
                        attempts=0, cache_hit=False, cpu_ms=0)
    seed_xai = [{
        "provider": "xai", "model": "grok-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 50, "cpu_ms": 1, "attempts": 1,
        "usage": {"provider": "xai", "model": "grok-test",
                  "prompt_tokens": 800, "completion_tokens": 400,
                  "cached_tokens": 0, "total_tokens": 1200,
                  "cost_usd": 0.001, "estimated": False, "purpose": "audit"},
    } for _ in range(10)]
    srv.log_usage("router-seed", "audit", seed_xai)

    judges, mode = srv._select_audit_judges([], coalesce=True, max_judges=3)
    assert mode == "coalesced"
    names = [j.name for j in judges]
    # anthropic (reliable + cheaper-than-xai) should outrank xai (8 errors).
    assert names.index("anthropic") < names.index("xai"), names

    # ------------------------------------------------------------------
    # H) explain filters
    # ------------------------------------------------------------------
    # Seed a session with multiple purposes + providers.
    sess = srv._session_load("explain-filter-test")
    answers = [
        {"provider": "openai", "model": "gpt-test", "response": "ok",
         "cache_hit": False, "elapsed_ms": 50, "cpu_ms": 1, "attempts": 1,
         "usage": {"provider": "openai", "model": "gpt-test",
                   "prompt_tokens": 100, "completion_tokens": 50,
                   "cached_tokens": 0, "total_tokens": 150,
                   "cost_usd": 0.0001, "estimated": False, "purpose": "confer"}},
        {"provider": "anthropic", "model": "claude-test", "response": "ok",
         "cache_hit": False, "elapsed_ms": 50, "cpu_ms": 1, "attempts": 1,
         "usage": {"provider": "anthropic", "model": "claude-test",
                   "prompt_tokens": 100, "completion_tokens": 50,
                   "cached_tokens": 0, "total_tokens": 150,
                   "cost_usd": 0.0008, "estimated": False, "purpose": "audit"}},
    ]
    srv._session_record(sess, answers, call_started=0.0, cpu_started=0.0)
    srv._session_save(sess)
    srv.log_usage("explain-filter-test", "confer", [answers[0]])
    srv.log_usage("explain-filter-test", "audit",  [answers[1]])

    # No filter -> both rows
    res = srv.tool_explain({"session_id": "explain-filter-test"})
    assert len(res["rows"]) == 2
    assert set(res["by_purpose"].keys()) == {"confer", "audit"}

    # Filter by purpose
    res = srv.tool_explain({"session_id":   "explain-filter-test",
                             "only_purpose": ["audit"]})
    assert len(res["rows"]) == 1
    assert res["rows"][0]["purpose"] == "audit"
    assert set(res["by_purpose"].keys()) == {"audit"}, res["by_purpose"]
    assert "applied_filters" in res
    assert res["applied_filters"]["only_purpose"] == ["audit"]

    # Filter by provider
    res = srv.tool_explain({"session_id":    "explain-filter-test",
                             "only_provider": ["openai"]})
    assert len(res["rows"]) == 1
    assert res["rows"][0]["provider"] == "openai"
    assert "anthropic" not in res["by_provider"]

    print("OK: test_polish_batch")
    return 0


if __name__ == "__main__":
    sys.exit(main())
