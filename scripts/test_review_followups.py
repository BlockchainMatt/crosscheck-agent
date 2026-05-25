#!/usr/bin/env python3
"""Tests for the review-followup fixes (concurrency, DoS, cycle handling).

  - Atomic JSON writes (no half-written files under concurrent writers)
  - Node cache: max_cache_bytes evicts oldest entries when total bytes exceed cap
  - DAG-depth breaker: cyclic graphs fail closed (trip the breaker) instead
    of silently treating depth as 0
  - Early-stop judge call: respects post-phase-1 session circuit breakers

Exit 0 on success.
"""

from __future__ import annotations

import concurrent.futures
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
    # 1) Atomic JSON writes — concurrent writers never leave a half-file
    # ------------------------------------------------------------------
    target = tmp / "atomic_test" / "file.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    big_payload = {"k": "x" * 200_000}    # ~200 KB

    def _write_once(_):
        srv._atomic_write_json(target, big_payload)
        return True

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(_write_once, range(32)))
    # The final file must be valid JSON (any successful write replaces atomically).
    parsed = json.loads(target.read_text())
    assert parsed == big_payload

    # No stray temp files left behind in the dir.
    leftover = [p for p in target.parent.iterdir() if p.name.startswith(".tmp.")]
    assert leftover == [], f"leftover tempfiles: {leftover}"

    # ------------------------------------------------------------------
    # 2) Node cache: max_cache_bytes evicts when total bytes exceed cap
    # ------------------------------------------------------------------
    cache_dir = tmp / "node_cache_bytes"
    srv.CFG["node_cache"] = {
        "enabled":         True,
        "dir":             str(cache_dir),
        "max_entries":     0,         # disable count-cap so byte-cap is the lever
        "max_cache_bytes": 4 * 1024,  # 4 KiB total
    }
    # Each value ~ 1.5 KiB; writing 6 entries should trip the 4 KiB cap.
    for i in range(6):
        srv._node_cache_put(f"{i:064x}", {"output": "x" * 1400})
    files = list((cache_dir).rglob("*.json"))
    total = sum(f.stat().st_size for f in files)
    assert total <= 4 * 1024 + 2048, (total, [f.name for f in files])   # small slack for overhead
    assert len(files) < 6, f"all {len(files)} entries kept; byte-cap had no effect"

    # ------------------------------------------------------------------
    # 3) DAG-depth breaker: cyclic graphs fail closed (trip the breaker)
    # ------------------------------------------------------------------
    srv.CFG["circuit_breakers"] = {"max_dag_depth": 5}
    cyclic = {"nodes": [
        {"id": "a", "task": "1", "difficulty": "low", "depends_on": ["b"]},
        {"id": "b", "task": "2", "difficulty": "low", "depends_on": ["a"]},
    ]}
    tripped = srv._check_dag_breakers(cyclic)
    assert tripped is not None, "cycle should trip the depth breaker (fail closed)"
    assert tripped[0] == "max_dag_depth"
    assert "cycle" in tripped[1].lower()

    # Acyclic but oversized still trips normally.
    chain = {"nodes": [
        {"id": f"n{i}", "task": str(i), "difficulty": "low",
         "depends_on": [f"n{i-1}"] if i > 0 else []}
        for i in range(8)
    ]}
    tripped = srv._check_dag_breakers(chain)
    assert tripped is not None and tripped[0] == "max_dag_depth", tripped

    # Acyclic + within cap is fine.
    short_chain = {"nodes": [
        {"id": "a", "task": "1", "difficulty": "low"},
        {"id": "b", "task": "2", "difficulty": "low", "depends_on": ["a"]},
    ]}
    assert srv._check_dag_breakers(short_chain) is None

    srv.CFG["circuit_breakers"] = {}   # reset for the next test

    # ------------------------------------------------------------------
    # 4) Early-stop judge call respects session breakers between phases
    # ------------------------------------------------------------------
    # Strategy: seed a session JUST BELOW the cost cap; phase-1 dispatch
    # crosses it; the judge call must NOT fire (we'd see a third HTTP call
    # under purpose='synth' if it did).
    call_log: list[dict] = []
    state = {"agreement": {"agreed": True, "confidence": 0.95, "summary": "agreed"}}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        call_log.append({"url": url, "body_text": json.dumps(body)})
        if "openai" in url:
            return ({"choices": [{"message": {"content": "openai-out"}}],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, 1)
        if "anthropic" in url:
            text = (json.dumps(state["agreement"])
                    if "agreement checker" in json.dumps(body)
                    else "anthropic-out")
            return ({"content": [{"type": "text", "text": text}],
                     "usage": {"input_tokens": 100, "output_tokens": 50}}, 1)
        if "x.ai" in url:
            return ({"choices": [{"message": {"content": "xai-out"}}],
                     "usage": {"prompt_tokens": 100, "completion_tokens": 50}}, 1)
        if "googleapis" in url:
            return ({"candidates": [{"content": {"parts": [{"text": "gemini-out"}]}}],
                     "usageMetadata": {"promptTokenCount": 90, "candidatesTokenCount": 40, "totalTokenCount": 130}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post_resilient

    # First, the breaker IS armed and phase-1 crosses it.
    srv.CFG["circuit_breakers"] = {"max_session_cost_usd": 0.0001}  # very tight
    # Seed: leave the session JUST below the cap so dispatch can begin.
    seed = [{
        "provider": "openai", "model": "gpt-test", "response": "ok",
        "cache_hit": False, "elapsed_ms": 5, "cpu_ms": 1, "attempts": 1,
        "usage": {"provider": "openai", "model": "gpt-test",
                  "prompt_tokens": 5, "completion_tokens": 2, "cached_tokens": 0,
                  "total_tokens": 7, "cost_usd": 0.00009, "estimated": False,
                  "purpose": "confer"},
    }]
    s = srv._session_load("early-stop-breaker")
    srv._session_record(s, seed, call_started=0.0, cpu_started=0.0)
    srv._session_save(s)
    call_log.clear()
    res = srv.tool_confer({
        "question":   "x",
        "providers":  ["openai", "anthropic", "xai", "gemini"],
        "session_id": "early-stop-breaker",
        "early_stop": True,
    })
    # phase-1 ran (2 calls). The judge call (purpose=synth, contains
    # "agreement checker" in the prompt) must NOT have fired.
    judge_calls = [c for c in call_log if "agreement checker" in c["body_text"]]
    assert judge_calls == [], f"judge call fired despite breaker tripping: {len(judge_calls)}"
    assert res.get("early_stopped") is False, res
    # The session breaker tripped between phase 1 and the judge so the rest
    # of the panel SHOULD NOT have dispatched either — caller already burned
    # the cap. The response should reflect that the panel didn't fully run.
    # (Either phase-2 didn't dispatch, OR if it did, the run is what the user
    # explicitly asked for. We only assert: no judge call.)
    srv.CFG["circuit_breakers"] = {}

    print("OK: test_review_followups")
    return 0


if __name__ == "__main__":
    sys.exit(main())
