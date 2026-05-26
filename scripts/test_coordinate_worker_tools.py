#!/usr/bin/env python3
"""Tests for worker_tools wired into tool_coordinate (PR #21 follow-up).

The challenge: coordinate's proposer/critic/synth roles emit
JSON-schema-validated envelopes via `_request_structured`. A
`<tool_call>` tag in the middle of an envelope would break schema
validation, so we run tool calls FIRST, then the structured emission.

Covers:
  - _request_structured_with_tools: proposer emits tool_call, then valid envelope
  - Hop-budget exhaustion inside the structured loop still ends in a final
    schema validation attempt
  - When worker_tools is empty, _request_structured is the identity loop
    (no tool hint injected, no extra system text bloating the prompt)
  - End-to-end tool_coordinate: proposer fetches mid-turn, critic too,
    synth is intentionally NOT given tools (purely combinatorial)
  - tool_coordinate.worker_tools metadata: accepted/rejected/applies_to
    surfaced on the response; synth is listed as excluded
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
        "openai":    {"gpt-test":    {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test":   {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
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
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing
    srv._CONFIG_PIN_STARTUP_DONE = True   # avoid noise during dispatch

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ENV["XAI_API_KEY"]       = "stub"; srv.ENV["XAI_MODEL"]       = "grok-test"
    srv.ALL_PROVIDERS = srv.build_providers()
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # Test fixtures
    # ------------------------------------------------------------------
    bodies: list[dict] = []
    openai_responses: list[str] = []
    anthropic_responses: list[str] = []
    xai_responses: list[str] = []
    fetched_urls: list[str] = []

    def fake_post(url, h, b, **kw):
        bodies.append({"url": url, "body": b})
        if "openai.com" in url:
            text = openai_responses.pop(0) if openai_responses else ""
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            text = anthropic_responses.pop(0) if anthropic_responses else ""
            return ({"content": [{"type": "text", "text": text}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        if "x.ai" in url:
            text = xai_responses.pop(0) if xai_responses else ""
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post

    # Stub the real fetch tool so we can confirm inner dispatch happened.
    real_tool_fetch = srv.tool_fetch
    def fake_tool_fetch(args):
        fetched_urls.append(args.get("url", ""))
        return {"tool": "fetch", "url": args.get("url"),
                "status": "ok",
                "content_excerpt": "Sample content the worker can cite."}
    srv.tool_fetch = fake_tool_fetch

    role_schema = srv._role_turn_schema()
    valid_proposer = json.dumps({
        "role": "proposer", "summary": "Draft position", "confidence": 0.8,
        "ballot": "agree",
    })
    valid_critic = json.dumps({
        "role": "critic", "summary": "Looks reasonable", "confidence": 0.7,
        "ballot": "agree",
    })
    valid_synth = json.dumps({
        "consensus": "Use opaque tokens.", "weighted_confidence": 0.85,
        "key_claims": [{"claim": "Simpler revocation", "confidence": 0.9}],
    })

    # ------------------------------------------------------------------
    # 1) _request_structured_with_tools — proposer emits tool_call,
    #    then a valid envelope
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/spec"}}</tool_call>',
        valid_proposer,
    ]
    obj, ans, errs = srv._request_structured(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "PROPOSER role."},
         {"role": "user",   "content": "Draft a position."}],
        role_schema,
        max_tokens=2048, deadline=time.monotonic() + 30, max_retries=1,
        purpose="worker",
        worker_tools=["fetch"], session_id="rst-happy",
    )
    assert errs == [], errs
    assert obj["role"] == "proposer", obj
    assert fetched_urls == ["https://example.com/spec"], fetched_urls
    assert ans.get("inner_tool_calls") == [{"hop": 1, "name": "fetch", "status": "ok"}], ans

    # ------------------------------------------------------------------
    # 2) Hop budget inside structured loop — 3 tool_calls then forced
    #    final emission; the refusal payload makes it into the worker's
    #    context but the final JSON still validates
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/a"}}</tool_call>',
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/b"}}</tool_call>',
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/c"}}</tool_call>',
        valid_proposer,
    ]
    obj, ans, errs = srv._request_structured(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "PROPOSER."},
         {"role": "user",   "content": "Draft."}],
        role_schema,
        max_tokens=2048, deadline=time.monotonic() + 30, max_retries=1,
        purpose="worker",
        worker_tools=["fetch"], session_id="rst-budget",
    )
    assert errs == [], errs
    assert obj["role"] == "proposer"
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    assert statuses == ["ok", "ok", "hop_budget_exhausted"], statuses
    # Only 2 fetches actually happened.
    assert len(fetched_urls) == 2, fetched_urls

    # ------------------------------------------------------------------
    # 3) worker_tools empty -> identity behavior of _request_structured
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [valid_proposer]
    obj, ans, errs = srv._request_structured(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "PROPOSER."},
         {"role": "user",   "content": "Draft."}],
        role_schema,
        max_tokens=2048, deadline=time.monotonic() + 30, max_retries=1,
        purpose="worker",
        worker_tools=[], session_id="rst-empty",
    )
    assert errs == [], errs
    assert obj["role"] == "proposer"
    # No inner_tool_calls field when worker_tools was empty.
    assert "inner_tool_calls" not in ans
    # And the system message did NOT receive the tool-use hint (it has
    # the schema instruction but not `<tool_call>` syntax).
    sys_content = next((m["content"] for m in bodies[0]["body"]["messages"]
                         if m["role"] == "system"), "")
    assert "SCHEMA:" in sys_content
    assert "<tool_call>" not in sys_content, sys_content

    # ------------------------------------------------------------------
    # 4) Schema validation retry preserved on tool-use path
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/x"}}</tool_call>',
        '{"role":"proposer"}',     # missing required `summary` + `confidence`
        valid_proposer,            # retry-on-fail
    ]
    obj, ans, errs = srv._request_structured(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "PROPOSER."},
         {"role": "user",   "content": "Draft."}],
        role_schema,
        max_tokens=2048, deadline=time.monotonic() + 30, max_retries=1,
        purpose="worker",
        worker_tools=["fetch"], session_id="rst-retry",
    )
    assert errs == [], errs
    assert obj["role"] == "proposer"
    # One inner tool call recorded; the retry doesn't count as a hop.
    assert ans["inner_tool_calls"] == [{"hop": 1, "name": "fetch", "status": "ok"}]

    # ------------------------------------------------------------------
    # 5) End-to-end coordinate: proposer + critic fetch; synth does NOT
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    # Proposer (anthropic) — fetch then envelope
    anthropic_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/spec"}}</tool_call>',
        valid_proposer,
        # Synth (also anthropic in this setup) — gets called LAST. Synth
        # has worker_tools=[] effectively (excluded by coordinate), so it
        # should NOT emit a tool_call. We give it a valid synth envelope.
        valid_synth,
    ]
    # Critics: openai + xai. Each fetches once then emits a critic envelope.
    openai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/critic-openai"}}</tool_call>',
        valid_critic,
    ]
    xai_responses[:] = [
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/critic-xai"}}</tool_call>',
        valid_critic,
    ]

    res = srv.tool_coordinate({
        "topic":       "Pick an auth strategy",
        "providers":   ["openai", "anthropic", "xai"],
        "proposer":    "anthropic",
        "critics":     ["openai", "xai"],
        "synthesizer": "anthropic",
        "worker_tools": ["fetch", "verify", "coordinate", "audit"],   # last two should be rejected
        "session_id":  "coord-tools-1",
    })
    # Metadata surfaced
    assert res["worker_tools"] == {
        "accepted":   ["fetch", "verify"],
        "rejected":   ["coordinate", "audit"],
        "hop_budget": 2,
        "applies_to": ["proposer", "critic"],
    }, res["worker_tools"]
    # Proposer + both critics fetched (3 inner fetches total). Synth did NOT.
    assert len(fetched_urls) == 3, fetched_urls
    assert "https://example.com/spec"          in fetched_urls
    assert "https://example.com/critic-openai" in fetched_urls
    assert "https://example.com/critic-xai"    in fetched_urls

    # Synth ran cleanly — the response carries a valid synthesis_structured
    assert res["synthesis_structured"] is not None, res
    assert res["synthesis_structured"]["consensus"] == "Use opaque tokens."

    # Inner-call records show up on the per-role answers
    prop_inner = res["proposal_answer"].get("inner_tool_calls") or []
    assert any(c.get("name") == "fetch" and c.get("status") == "ok"
               for c in prop_inner), prop_inner
    for crit_ans in res["critique_answers"]:
        ic = crit_ans.get("inner_tool_calls") or []
        assert any(c.get("name") == "fetch" and c.get("status") == "ok"
                   for c in ic), ic

    # Inspect the synth's wire body — it should NOT contain the
    # `<tool_call>` syntax hint that the proposer/critics got, because
    # coordinate intentionally excludes synth from worker_tools.
    # Identify by purpose tag on the body's messages (synth has the
    # SYNTHESIZER role marker).
    synth_bodies = []
    for b in bodies:
        sys_block = (b["body"].get("system") or "") + "\n".join(
            (m.get("content") or "") for m in b["body"].get("messages") or []
            if isinstance(m, dict) and m.get("role") == "system"
        )
        if "SYNTHESIZER" in sys_block:
            synth_bodies.append(sys_block)
    assert synth_bodies, "expected at least one synth-role dispatch"
    assert all("<tool_call>" not in s for s in synth_bodies), \
        "synth system prompt should NOT carry the tool_call hint"

    # ------------------------------------------------------------------
    # 6) coordinate WITHOUT worker_tools = legacy single-shot behavior;
    #    no `worker_tools` metadata on the response
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    anthropic_responses[:] = [valid_proposer, valid_synth]
    openai_responses[:]    = [valid_critic]
    xai_responses[:]       = [valid_critic]
    res = srv.tool_coordinate({
        "topic":       "Plain coordinate, no tools",
        "providers":   ["openai", "anthropic", "xai"],
        "proposer":    "anthropic",
        "critics":     ["openai", "xai"],
        "synthesizer": "anthropic",
        "session_id":  "coord-plain",
    })
    assert "worker_tools" not in res, res
    assert fetched_urls == [], fetched_urls

    srv.tool_fetch = real_tool_fetch
    print("OK: test_coordinate_worker_tools")
    return 0


if __name__ == "__main__":
    sys.exit(main())
