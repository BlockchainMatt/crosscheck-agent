#!/usr/bin/env python3
"""Offline tests for the second batch of improvements:

  A. DAG-node level cache  — partial-recombine retry cache-hits unchanged nodes
  B. Session circuit breakers — cost / tokens / wall / dag-nodes / dag-depth
  C. Early-stop panel — confer skips remaining providers when first 2 agree

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
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}        # exact-match cache off
    srv.CFG["node_cache"]     = {"enabled": True,
                                  "dir": str(tmp / "node_cache")}
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
    # Shared HTTP stub
    # ------------------------------------------------------------------
    call_log: list[dict] = []
    state = {"agreement": {"agreed": True, "confidence": 0.9, "summary": "they agree"}}

    def _classify(body: dict) -> str:
        parts = []
        for m in (body.get("messages") or []):
            if isinstance(m.get("content"), str): parts.append(m["content"])
        for c in (body.get("contents") or []):
            for p in (c.get("parts") or []):
                if isinstance(p.get("text"), str): parts.append(p["text"])
        if isinstance(body.get("system"), str): parts.append(body["system"])
        sys_inst = body.get("systemInstruction") or {}
        for p in (sys_inst.get("parts") or []):
            if isinstance(p.get("text"), str): parts.append(p["text"])
        text = "\n".join(parts)
        if "agreement checker" in text or '"agreed":' in text:
            return "agreement"
        return "plain"

    def fake_post(url, headers, body, timeout):
        call_log.append({"url": url})
        kind = _classify(body)
        if kind == "agreement":
            payload = state["agreement"]
            text = json.dumps(payload)
        else:
            text = f"answer from {'openai' if 'openai' in url else 'anthropic' if 'anthropic' in url else 'xai' if 'x.ai' in url else 'gemini'}"
        if "openai" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10}}
        if "anthropic" in url:
            return {"content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 30, "output_tokens": 10}}
        if "x.ai" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10}}
        if "googleapis" in url:
            return {"candidates": [{"content": {"parts": [{"text": text}]}}],
                    "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 8, "totalTokenCount": 33}}
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        return fake_post(url, headers, body, timeout), 1
    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # ------------------------------------------------------------------
    # A) DAG-node cache: re-running an identical orchestrate run cache-hits
    # ------------------------------------------------------------------
    dag = {
        "summary": "tiny",
        "nodes": [
            {"id": "n1", "task": "one",   "difficulty": "low"},
            {"id": "n2", "task": "two",   "difficulty": "med", "depends_on": ["n1"]},
        ],
    }
    call_log.clear()
    res1 = srv.tool_orchestrate({"dag": dag, "providers": ["openai", "anthropic", "xai"]})
    assert not res1.get("error"), res1
    first_run_calls = len(call_log)
    assert first_run_calls > 0
    # Each node result records cache miss the first time.
    for n in res1["nodes"]:
        if n["status"] == "ok":
            assert n.get("node_cache_hit") is False, n

    call_log.clear()
    res2 = srv.tool_orchestrate({"dag": dag, "providers": ["openai", "anthropic", "xai"]})
    second_run_calls = len(call_log)
    # Workers should cache-hit on the second run. The DAG planner is bypassed
    # because we passed `dag`, and the recombine still runs (so a couple of
    # calls remain) but workers do NOT.
    assert second_run_calls < first_run_calls, (first_run_calls, second_run_calls)
    cached_nodes = [n for n in res2["nodes"] if n.get("node_cache_hit")]
    assert len(cached_nodes) >= 1, res2["nodes"]

    # ------------------------------------------------------------------
    # B) Circuit breakers
    # ------------------------------------------------------------------
    # 1. max_session_cost_usd trips when the cumulative session cost crosses
    #    the cap BEFORE the next tool call runs.
    srv.CFG["circuit_breakers"] = {"max_session_cost_usd": 0.0001}
    # Seed the session with a tiny prior call so total_cost_usd > cap.
    seed_answers = [{
        "provider": "openai", "model": "gpt-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 5, "cpu_ms": 1, "attempts": 1,
        "usage": {"provider": "openai", "model": "gpt-test",
                  "prompt_tokens": 100, "completion_tokens": 50,
                  "cached_tokens": 0, "total_tokens": 150,
                  "cost_usd": 0.001, "estimated": False, "purpose": "confer"},
    }]
    s = srv._session_load("breaker-cost")
    srv._session_record(s, seed_answers, call_started=0.0, cpu_started=0.0)
    srv._session_save(s)

    res = srv.tool_confer({"question": "x", "providers": ["openai"],
                           "session_id": "breaker-cost"})
    assert res.get("error_code") == "CIRCUIT_BREAKER_TRIPPED", res
    assert res.get("breaker") == "max_session_cost_usd"

    # 2. max_dag_nodes — orchestrate refuses a DAG with too many nodes.
    srv.CFG["circuit_breakers"] = {"max_dag_nodes": 2}
    big_dag = {"nodes": [{"id": f"n{i}", "task": f"t{i}", "difficulty": "low"}
                          for i in range(5)]}
    res = srv.tool_orchestrate({"dag": big_dag,
                                "providers": ["openai", "anthropic"]})
    assert res.get("error_code") == "CIRCUIT_BREAKER_TRIPPED", res
    assert res.get("breaker") == "max_dag_nodes"

    # 3. max_dag_depth — a chain of 4 nodes against a cap of 2 trips.
    srv.CFG["circuit_breakers"] = {"max_dag_depth": 2}
    chain = {"nodes": [
        {"id": "a", "task": "1", "difficulty": "low"},
        {"id": "b", "task": "2", "difficulty": "low", "depends_on": ["a"]},
        {"id": "c", "task": "3", "difficulty": "low", "depends_on": ["b"]},
        {"id": "d", "task": "4", "difficulty": "low", "depends_on": ["c"]},
    ]}
    res = srv.tool_orchestrate({"dag": chain,
                                "providers": ["openai", "anthropic"]})
    assert res.get("error_code") == "CIRCUIT_BREAKER_TRIPPED", res
    assert res.get("breaker") == "max_dag_depth"

    # Cleanup: clear breaker config.
    srv.CFG["circuit_breakers"] = {}

    # ------------------------------------------------------------------
    # C) Early-stop panel: agreement -> skip
    # ------------------------------------------------------------------
    call_log.clear()
    state["agreement"] = {"agreed": True, "confidence": 0.9, "summary": "they agree"}
    res = srv.tool_confer({
        "question":   "is the sky blue?",
        "providers":  ["openai", "anthropic", "xai", "gemini"],
        "early_stop": True,
    })
    assert res.get("early_stopped") is True, res
    # Only 2 panelist answers (phase 1) should be in `answers`.
    assert len(res["answers"]) == 2, [a.get("provider") for a in res["answers"]]
    assert sorted(res["skipped_providers"]) == sorted(["xai", "gemini"])
    assert res["agreement_check"]["agreed"] is True
    assert res["agreement_check"]["confidence"] >= 0.7

    # Disagreement -> dispatches the full panel
    call_log.clear()
    state["agreement"] = {"agreed": False, "confidence": 0.95, "summary": "they disagree"}
    res = srv.tool_confer({
        "question":   "another question",
        "providers":  ["openai", "anthropic", "xai", "gemini"],
        "early_stop": True,
    })
    assert res.get("early_stopped") is False, res
    assert res.get("skipped_providers") == []
    assert len(res["answers"]) == 4, res["answers"]
    assert res["agreement_check"]["agreed"] is False

    # Sub-3 panel: early_stop is a no-op.
    call_log.clear()
    state["agreement"] = {"agreed": True, "confidence": 0.99, "summary": "agreed"}
    res = srv.tool_confer({
        "question":   "tiny panel",
        "providers":  ["openai", "anthropic"],
        "early_stop": True,
    })
    assert res.get("early_stopped") is False, res
    assert len(res["answers"]) == 2

    # Threshold gate: agreed=true but confidence below threshold doesn't trip.
    call_log.clear()
    state["agreement"] = {"agreed": True, "confidence": 0.4, "summary": "weak agreement"}
    res = srv.tool_confer({
        "question":   "low confidence",
        "providers":  ["openai", "anthropic", "xai", "gemini"],
        "early_stop": True,
        "early_stop_threshold": 0.7,
    })
    assert res.get("early_stopped") is False, res
    assert len(res["answers"]) == 4

    print("OK: test_p1_breakers_cache_early_stop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
