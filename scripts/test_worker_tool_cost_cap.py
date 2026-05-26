#!/usr/bin/env python3
"""Tests for the per-turn worker tool-use cost cap.

Three modes:
  - warn (default): emit warning event + attach cost_cap block; keep going
  - enforce:        refuse next inner tool call when cap is exceeded
  - off:            no checks at all

The user explicitly asked for warn-as-default + an agent-side
AskUserQuestion follow-up flow; the server emits the structured signal
so the agent can surface it.
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
    # Generous per-token cost so cap thresholds are easy to reason about.
    # gpt-test: 30 prompt + 10 completion = 30*0.01 + 10*0.05 = $0.80 per call.
    pricing.write_text(json.dumps({
        "openai":    {"gpt-test":    {"prompt_per_1k": 10.0,  "completion_per_1k": 50.0, "cached_per_1k": 5.0}},
        "anthropic": {"claude-test": {"prompt_per_1k": 10.0,  "completion_per_1k": 50.0, "cached_per_1k": 5.0}},
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)
    os.environ.pop("CROSSCHECK_REJECT_CONFIG_DRIFT", None)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.CFG["prompt_adapters"] = {"enabled": False}
    srv.CFG["fetch"] = {"url_allowlist": ["https://example.com/"]}
    srv.CFG["config_pinning"] = {"reject_drift": False}
    srv.CFG.pop("worker_tools", None)
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing
    srv._CONFIG_PIN_STARTUP_DONE = True

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ALL_PROVIDERS = srv.build_providers()
    srv.CFG["providers"] = ["openai", "anthropic"]
    srv.CFG["moderator"] = "anthropic"

    openai_responses: list[str] = []
    fetched_urls: list[str] = []

    def fake_post(url, h, b, **kw):
        if "openai.com" in url:
            text = openai_responses.pop(0) if openai_responses else "DONE."
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            text = openai_responses.pop(0) if openai_responses else "DONE."
            return ({"content": [{"type": "text", "text": text}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post

    real_tool_fetch = srv.tool_fetch
    def fake_tool_fetch(args):
        fetched_urls.append(args.get("url", ""))
        return {"tool": "fetch", "url": args.get("url"),
                "status": "ok", "content_excerpt": "stub"}
    srv.tool_fetch = fake_tool_fetch

    p = srv.ALL_PROVIDERS["openai"]

    # ------------------------------------------------------------------
    # 1) Defaults helper
    # ------------------------------------------------------------------
    # No CFG, no kwargs -> disabled
    cap, mode = srv._worker_tool_cost_cap_defaults(None, None)
    assert cap is None and mode == "warn"  # mode defaults to warn but cap=None disables

    # Per-call cap with explicit mode
    cap, mode = srv._worker_tool_cost_cap_defaults(0.5, "enforce")
    assert cap == 0.5 and mode == "enforce"

    # 0 / negative -> disabled
    cap, mode = srv._worker_tool_cost_cap_defaults(0, "warn")
    assert cap is None
    cap, mode = srv._worker_tool_cost_cap_defaults(-1.0, "warn")
    assert cap is None

    # Bad mode falls through to warn
    cap, mode = srv._worker_tool_cost_cap_defaults(0.5, "blah")
    assert mode == "warn"

    # CFG default picked up when kwargs absent
    srv.CFG["worker_tools"] = {"cost_cap_usd": 0.25, "cost_cap_mode": "enforce"}
    cap, mode = srv._worker_tool_cost_cap_defaults(None, None)
    assert cap == 0.25 and mode == "enforce"

    # Per-call kwarg beats CFG default
    cap, mode = srv._worker_tool_cost_cap_defaults(1.0, "warn")
    assert cap == 1.0 and mode == "warn"
    srv.CFG.pop("worker_tools", None)

    # ------------------------------------------------------------------
    # 2) warn mode: cap crossed, loop continues, block attached
    # ------------------------------------------------------------------
    # Each call costs $0.80. Cap at $1.00 -> first round under cap, second
    # round (after first fetch + LLM re-prompt) takes cumulative to $1.60
    # which trips the warning. Worker emits final answer.
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        # After re-prompt + LLM response, cumulative is $1.60 (over $1.00).
        # warn mode: keep going. Worker emits one MORE tool call, allowed.
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/b"}}</tool_call>',
        # Final answer after second fetch.
        "Done with sources gathered.",
    ]
    fetched_urls.clear()
    ans = srv._ask_one_with_tools(
        p,
        [{"role": "system", "content": "You are helpful."},
         {"role": "user",   "content": "Investigate."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="warn-mode",
        cost_cap_usd=1.0, cost_cap_mode="warn",
    )
    assert "Done with sources gathered" in ans["response"], ans
    cc = ans["cost_cap"]
    assert cc["cap_usd"] == 1.0
    assert cc["mode"] == "warn"
    assert cc["exceeded"] is True, cc
    assert cc["blocked"] is False, cc
    # Both fetches executed (warn never blocks)
    assert len(fetched_urls) == 2, fetched_urls
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    assert statuses == ["ok", "ok"], statuses

    # ------------------------------------------------------------------
    # 3) enforce mode: next inner call refused after cap crossed
    # ------------------------------------------------------------------
    # Cap at $1.00. First fetch + reprompt -> $1.60 -> over cap.
    # Worker requests a SECOND fetch but it's refused. Worker gets one
    # final round to produce its answer.
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/b"}}</tool_call>',
        "Final answer with whatever we had.",
    ]
    fetched_urls.clear()
    ans = srv._ask_one_with_tools(
        p,
        [{"role": "system", "content": "You are helpful."},
         {"role": "user",   "content": "Investigate."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="enforce-mode",
        cost_cap_usd=1.0, cost_cap_mode="enforce",
    )
    cc = ans["cost_cap"]
    assert cc["mode"] == "enforce"
    assert cc["exceeded"] is True, cc
    assert cc["blocked"] is True,  cc
    # Only ONE fetch ran; the second got cost_cap_exceeded
    assert len(fetched_urls) == 1, fetched_urls
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    assert statuses == ["ok", "cost_cap_exceeded"], statuses
    assert "Final answer" in ans["response"]

    # ------------------------------------------------------------------
    # 4) off mode: no checks at all (no cost_cap block, no events)
    # ------------------------------------------------------------------
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        "Done.",
    ]
    fetched_urls.clear()
    ans = srv._ask_one_with_tools(
        p,
        [{"role": "user", "content": "Investigate."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="off-mode",
        cost_cap_usd=0.01,           # would absolutely trip in warn/enforce
        cost_cap_mode="off",
    )
    assert "cost_cap" not in ans, ans

    # ------------------------------------------------------------------
    # 5) Cap not set -> no cost_cap block (legacy worker_tools behavior)
    # ------------------------------------------------------------------
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        "Done.",
    ]
    fetched_urls.clear()
    ans = srv._ask_one_with_tools(
        p,
        [{"role": "user", "content": "Investigate."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="no-cap",
    )
    assert "cost_cap" not in ans

    # ------------------------------------------------------------------
    # 6) Cap NOT exceeded -> block still attached but exceeded=false
    # ------------------------------------------------------------------
    openai_responses[:] = [
        "Immediate answer, no tool calls.",
    ]
    ans = srv._ask_one_with_tools(
        p,
        [{"role": "user", "content": "Hi."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="under-cap",
        cost_cap_usd=5.0, cost_cap_mode="warn",
    )
    cc = ans["cost_cap"]
    assert cc["cap_usd"] == 5.0
    assert cc["exceeded"] is False, cc
    assert cc["blocked"] is False

    # ------------------------------------------------------------------
    # 7) Structured variant: cost_cap honored inside _request_structured_with_tools
    # ------------------------------------------------------------------
    role_schema = srv._role_turn_schema()
    valid_proposer = json.dumps({
        "role": "proposer", "summary": "draft", "confidence": 0.8,
        "ballot": "agree",
    })
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/b"}}</tool_call>',
        valid_proposer,
    ]
    fetched_urls.clear()
    obj, ans, errs = srv._request_structured(
        p,
        [{"role": "system", "content": "PROPOSER."},
         {"role": "user",   "content": "Draft."}],
        role_schema,
        max_tokens=2048, deadline=__import__("time").monotonic() + 30,
        max_retries=1, purpose="worker",
        worker_tools=["fetch"], session_id="rst-enforce",
        cost_cap_usd=1.0, cost_cap_mode="enforce",
    )
    assert errs == [], errs
    assert obj["role"] == "proposer"
    cc = ans["cost_cap"]
    assert cc["blocked"] is True, cc
    # Only one fetch executed; second refused with cost_cap_exceeded
    assert len(fetched_urls) == 1, fetched_urls
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    assert "cost_cap_exceeded" in statuses, statuses

    # ------------------------------------------------------------------
    # 8) End-to-end coordinate surfaces cost_cap on result + operator_prompt
    # ------------------------------------------------------------------
    valid_critic = json.dumps({
        "role": "critic", "summary": "looks ok", "confidence": 0.7,
        "ballot": "agree",
    })
    valid_synth = json.dumps({
        "consensus": "use opaque tokens", "weighted_confidence": 0.85,
        "key_claims": [],
    })
    # Proposer (anthropic) does 2 fetches + final emission -> exceeds cap
    # Critics (openai) each do 0 fetches + final emission -> under cap individually
    # Synth (anthropic) is not given tools -> no cost_cap block
    openai_responses[:] = [
        # Anthropic proposer: 2 tool calls + final
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/p1"}}</tool_call>',
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/p2"}}</tool_call>',
        valid_proposer,
        # OpenAI critic: final immediately
        valid_critic,
        # Synth (anthropic): final immediately
        valid_synth,
    ]
    fetched_urls.clear()
    res = srv.tool_coordinate({
        "topic":       "tokens",
        "providers":   ["openai", "anthropic"],
        "proposer":    "anthropic",
        "critics":     ["openai"],
        "synthesizer": "anthropic",
        "worker_tools": ["fetch"],
        "worker_tool_cost_cap_usd":  1.0,
        "worker_tool_cost_cap_mode": "warn",
        "session_id":  "coord-warn",
    })
    wt = res["worker_tools"]
    assert "cost_cap" in wt, wt
    cc = wt["cost_cap"]
    assert cc["cap_usd"] == 1.0 and cc["mode"] == "warn"
    assert cc["exceeded_any"] is True
    assert cc["blocked_any"] is False
    # operator_prompt only appears when exceeded but NOT blocked (warn mode)
    assert "operator_prompt" in cc, cc
    # Synth not in per_role list
    roles_in_caps = [r["role"] for r in cc["per_role"]]
    assert "synthesizer" not in roles_in_caps and "synth" not in roles_in_caps, roles_in_caps
    # Proposer is in there
    assert "proposer" in roles_in_caps, roles_in_caps

    srv.tool_fetch = real_tool_fetch
    print("OK: test_worker_tool_cost_cap")
    return 0


if __name__ == "__main__":
    sys.exit(main())
