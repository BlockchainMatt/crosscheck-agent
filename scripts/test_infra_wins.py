#!/usr/bin/env python3
"""Offline tests for PR 1 — quick infra wins:
  - per-purpose `max_tokens` budgets (caps via `_budget_for_purpose`)
  - prompt canonicalization for the cache key (versioned `v2:` payload)
  - error taxonomy helper (`_error` envelope with code/kind/hint/transient)
  - `plan_only` mode on `orchestrate` (and forwarded by `create`/`create_cheap`)

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
        "openai":    {"gpt-test-low":  {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test-mid":{"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test-high": {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "gemini":    {"gemini-test":    {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0001}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test-low"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test-mid"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test-high"}]},
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
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test-low"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test-mid"
    srv.ENV["XAI_API_KEY"]       = "stub"; srv.ENV["XAI_MODEL"]       = "grok-test-high"
    srv.ENV["GEMINI_API_KEY"]    = "stub"; srv.ENV["GEMINI_MODEL"]    = "gemini-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai", "gemini"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # 1) Per-purpose max_tokens budgets
    # ------------------------------------------------------------------
    # Defaults
    assert srv._budget_for_purpose("audit")  == 512
    assert srv._budget_for_purpose("synth")  == 1024
    assert srv._budget_for_purpose("worker") == 2048
    # Unknown purpose falls through to None (no cap applied)
    assert srv._budget_for_purpose("nope") is None
    # Caller override via CFG.token_budgets wins
    srv.CFG["token_budgets"] = {"audit": 256, "custom": 999}
    assert srv._budget_for_purpose("audit")  == 256
    assert srv._budget_for_purpose("custom") == 999
    assert srv._budget_for_purpose("synth")  == 1024   # default still applies
    srv.CFG["token_budgets"] = {}                       # reset

    # Verify the budget actually caps `max_tokens` sent to the provider.
    captured_bodies: list[dict] = []
    def fake_post_resilient(url, headers, body, timeout, deadline):
        captured_bodies.append({"url": url, "body": body})
        if "openai" in url:
            return ({"choices": [{"message": {"content": "ok"}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic" in url:
            return ({"content": [{"type": "text", "text": "ok"}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post_resilient

    # Call _ask_one with a large max_tokens but purpose=audit. The actual
    # `max_tokens` (OpenAI) or `max_tokens` (Anthropic) sent on the wire must
    # be capped at the audit budget (512).
    captured_bodies.clear()
    srv._ask_one(srv.ALL_PROVIDERS["openai"],
                 [{"role": "user", "content": "hi"}],
                 deadline=__import__("time").monotonic() + 10,
                 max_tokens=8000, purpose="audit")
    assert captured_bodies, "fake post should have been called"
    assert captured_bodies[-1]["body"].get("max_tokens") == 512, captured_bodies[-1]

    captured_bodies.clear()
    srv._ask_one(srv.ALL_PROVIDERS["anthropic"],
                 [{"role": "user", "content": "hi"}],
                 deadline=__import__("time").monotonic() + 10,
                 max_tokens=8000, purpose="worker")
    assert captured_bodies[-1]["body"].get("max_tokens") == 2048, captured_bodies[-1]

    # Caller passing a SMALLER max_tokens than the budget should still win
    # (budget is a ceiling, not a floor).
    captured_bodies.clear()
    srv._ask_one(srv.ALL_PROVIDERS["openai"],
                 [{"role": "user", "content": "hi"}],
                 deadline=__import__("time").monotonic() + 10,
                 max_tokens=100, purpose="worker")
    assert captured_bodies[-1]["body"].get("max_tokens") == 100, captured_bodies[-1]

    # ------------------------------------------------------------------
    # 2) Prompt canonicalization for the cache key
    # ------------------------------------------------------------------
    msgs_a = [{"role": "user", "content": "Look at session abc-123, timestamp 2026-05-25T14:00:00Z"}]
    msgs_b = [{"role": "user", "content": "Look at session abc-123, timestamp 2026-05-26T09:14:32Z"}]
    msgs_c = [{"role": "user", "content": "Look at session 12345678-1234-1234-1234-123456789012, timestamp 2026-05-25T14:00:00Z"}]
    msgs_d = [{"role": "user", "content": "Different prompt entirely."}]

    k_a = srv._cache_key("openai", "gpt-test-low", msgs_a, 200, 0.4)
    k_b = srv._cache_key("openai", "gpt-test-low", msgs_b, 200, 0.4)
    k_c = srv._cache_key("openai", "gpt-test-low", msgs_c, 200, 0.4)
    k_d = srv._cache_key("openai", "gpt-test-low", msgs_d, 200, 0.4)

    # Different timestamps must collapse to the same key.
    assert k_a == k_b, "ISO timestamps should be canonicalized to a placeholder"
    # UUID gets canonicalized too -> same key as msgs_a once the UUID was a placeholder?
    # No — msgs_c has a different LITERAL non-UUID-like substring before the UUID.
    # The canonicalizer just replaces the UUID and the timestamp; the prefix differs.
    # So k_c != k_a.
    assert k_c != k_a, "different message bodies should still produce different keys"
    # Unrelated prompt -> different key
    assert k_d != k_a

    # Verify the canonicalize helpers directly
    out = srv._canonicalize_text("Hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 and uuid "
                                 "11111111-2222-3333-4444-555555555555 at 2026-05-25T14:00Z")
    assert "<hash>" in out and "<uuid>" in out and "<ts>" in out, out

    # ------------------------------------------------------------------
    # 3) Error taxonomy helper
    # ------------------------------------------------------------------
    env = srv._error("MY_CODE", "human message", kind="config",
                     hint="do this thing", transient=False, extra_field="x")
    assert env["error"] == "human message"
    assert env["error_code"] == "MY_CODE"
    assert env["error_kind"] == "config"
    assert env["operator_hint"] == "do this thing"
    assert env["transient"] is False
    assert env["extra_field"] == "x"

    # orchestrate surfaces the new shape on the args-mutually-exclusive path.
    res = srv.tool_orchestrate({"goal": "x", "dag": {"nodes": []}})
    assert res.get("error_code") == "ORCHESTRATE_ARGS_MUTUALLY_EXCLUSIVE", res
    assert "operator_hint" in res

    # orchestrate surfaces NO_PROVIDERS_AVAILABLE on empty provider list.
    saved_providers = srv.ALL_PROVIDERS
    srv.ALL_PROVIDERS = {}
    res = srv.tool_orchestrate({"goal": "x"})
    assert res.get("error_code") in ("NO_PROVIDERS_AVAILABLE", "ORCHESTRATE_ARGS_MUTUALLY_EXCLUSIVE"), res
    srv.ALL_PROVIDERS = saved_providers

    # ------------------------------------------------------------------
    # 4) plan_only mode on orchestrate
    # ------------------------------------------------------------------
    # Pre-authored DAG; planner is skipped, workers + recombine skipped too.
    captured_bodies.clear()
    res = srv.tool_orchestrate({
        "dag": {
            "summary": "test",
            "nodes": [
                {"id": "n1", "task": "easy",   "difficulty": "low"},
                {"id": "n2", "task": "medium", "difficulty": "med", "depends_on": ["n1"]},
                {"id": "n3", "task": "hard",   "difficulty": "high","depends_on": ["n2"]},
            ],
        },
        "providers":  ["openai", "anthropic", "xai"],
        "cheap_mode": True,
        "plan_only":  True,
    })
    assert res.get("plan_only") is True, res
    # No worker / recombine calls were made.
    assert captured_bodies == [], f"plan_only must not call any provider: {captured_bodies}"
    nodes = res["nodes"]
    assert len(nodes) == 3
    # Cheap-mode routing should pick the per-tier model.
    by_id = {n["id"]: n for n in nodes}
    assert by_id["n1"]["provider"] == "openai"
    assert by_id["n2"]["provider"] == "anthropic"
    assert by_id["n3"]["provider"] == "xai"
    assert res["estimated_total_cost_usd"] > 0, res
    assert "estimated_total_tokens" in res
    assert "note" in res and "plan_only" in res["note"]
    # Synth call cost is also estimated.
    assert res["synth"]["provider"] == "anthropic", res["synth"]
    assert res["synth"]["estimated_cost_usd"] > 0

    # plan_only forwarded by `create` skips workers, review, AND audit.
    captured_bodies.clear()
    res = srv.tool_create({
        "instruction": "test the plan_only path",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "plan-only-create",
        "plan_only":   True,
    })
    # confer scope and orchestrate planner still ran (they're cheap / planning
    # itself is what we want to preview). But no orchestrate workers, no review,
    # no audit.
    audit_calls = sum(1 for b in captured_bodies if "RUBRIC ITEMS:" in json.dumps(b))
    assert audit_calls == 0, f"plan_only must not call audit: {audit_calls}"
    assert res["status"] == "plan_only"
    assert res["review"] is None if "review" in res else True
    assert res["audit"]  is None if "audit"  in res else True
    assert "plan_only_estimate" in res

    print("OK: test_infra_wins")
    return 0


if __name__ == "__main__":
    sys.exit(main())
