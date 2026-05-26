#!/usr/bin/env python3
"""Tests for the session working memory ledger.

Covers:
  - CRUD helpers (add / list / mark_stale / clear)
  - tool_session_memory dispatch + error taxonomy
  - Stale rows excluded from default listings and from the injection block
  - _session_memory_inject prepends a <session_memory> wrapper to first user msg
  - coordinate auto-writes consensus/key_claims/dissent/open_questions
  - audit with passed=false marks every entry in the session stale
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

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.CFG["prompt_adapters"]= {"enabled": False}   # keep wire payloads stable
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ENV["XAI_API_KEY"]       = "stub"; srv.ENV["XAI_MODEL"]       = "grok-test"
    srv.ALL_PROVIDERS = srv.build_providers()

    sid = "memtest-1"

    # ------------------------------------------------------------------
    # 1) CRUD helpers
    # ------------------------------------------------------------------
    id1 = srv._session_memory_add(sid, "decision", "Adopt opaque tokens")
    id2 = srv._session_memory_add(sid, "fact",     "Postgres-backed sessions")
    id3 = srv._session_memory_add(sid, "open_question", "How to handle dual-write window?")
    assert id1 < id2 < id3

    rows = srv._session_memory_list(sid)
    assert len(rows) == 3
    kinds = {r["kind"] for r in rows}
    assert kinds == {"decision", "fact", "open_question"}

    # Stale filter excludes by default
    n = srv._session_memory_mark_stale(sid, ids=[id2], reason="contradicted")
    assert n == 1
    rows = srv._session_memory_list(sid)
    assert len(rows) == 2 and all(r["id"] != id2 for r in rows)
    rows = srv._session_memory_list(sid, include_stale=True)
    assert len(rows) == 3

    # Filter by kind
    only_facts = srv._session_memory_list(sid, kinds=["fact"], include_stale=True)
    assert len(only_facts) == 1 and only_facts[0]["kind"] == "fact"

    # ------------------------------------------------------------------
    # 2) Render block excludes stale; respects ordering
    # ------------------------------------------------------------------
    block = srv._session_memory_block(sid)
    assert "<session_memory>" in block and "</session_memory>" in block
    assert "Adopt opaque tokens" in block
    assert "Postgres-backed sessions" not in block   # stale
    assert "dual-write" in block

    # No memory → empty block
    assert srv._session_memory_block("never-existed-sid") == ""
    # Falsy session_id → empty block
    assert srv._session_memory_block(None) == ""
    assert srv._session_memory_block("") == ""

    # ------------------------------------------------------------------
    # 3) Injection prepends to first user message
    # ------------------------------------------------------------------
    msgs = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user",   "content": "What about TTL?"},
    ]
    out = srv._session_memory_inject(msgs, sid)
    assert out[0]["content"] == "You are helpful."  # system untouched
    assert "<session_memory>" in out[1]["content"]
    assert out[1]["content"].endswith("What about TTL?")

    # No user message → no-op
    sys_only = [{"role": "system", "content": "hi"}]
    out = srv._session_memory_inject(sys_only, sid)
    assert out == sys_only

    # ------------------------------------------------------------------
    # 4) tool_session_memory error taxonomy
    # ------------------------------------------------------------------
    res = srv.tool_session_memory({"action": "list"})
    assert res.get("error_code") == "SESSION_MEMORY_MISSING_SESSION_ID", res

    res = srv.tool_session_memory({"action": "nope", "session_id": sid})
    assert res.get("error_code") == "SESSION_MEMORY_BAD_ACTION", res

    res = srv.tool_session_memory({"action": "add", "session_id": sid,
                                    "kind": "bogus", "content": "x"})
    assert res.get("error_code") == "SESSION_MEMORY_BAD_KIND", res

    res = srv.tool_session_memory({"action": "add", "session_id": sid,
                                    "kind": "fact", "content": "  "})
    assert res.get("error_code") == "SESSION_MEMORY_EMPTY_CONTENT", res

    # ------------------------------------------------------------------
    # 5) tool_session_memory happy path
    # ------------------------------------------------------------------
    res = srv.tool_session_memory({"action": "list", "session_id": sid})
    pre_count = res["count"]
    res = srv.tool_session_memory({"action": "add", "session_id": sid,
                                    "kind": "fact", "content": "added via tool"})
    assert res["action"] == "add" and isinstance(res["id"], int)
    res = srv.tool_session_memory({"action": "list", "session_id": sid})
    assert res["count"] == pre_count + 1

    res = srv.tool_session_memory({"action": "clear", "session_id": sid})
    assert res["deleted"] >= pre_count + 1

    # ------------------------------------------------------------------
    # 6) coordinate auto-writes consensus/key_claims/dissent/open_questions
    # ------------------------------------------------------------------
    sid2 = "memtest-coord"

    def fake_post(url, h, b, **kw):
        if "anthropic.com" in url:
            # Inspect prompt to decide which role is being asked
            sysblk = b.get("system") or ""
            if "SYNTHESIZER" in sysblk:
                obj = {"consensus": "Use opaque tokens",
                       "weighted_confidence": 0.85,
                       "key_claims": [
                           {"claim": "Opaque tokens simplify revocation", "confidence": 0.9},
                           {"claim": "Postgres-backed session store",      "confidence": 0.8},
                       ],
                       "dissent": [
                           {"claim": "JWT might be cheaper at scale", "providers": ["xai"]},
                       ],
                       "open_questions": [
                           "How to handle the dual-write window?"
                       ]}
            else:
                obj = {"role": "proposer", "summary": "draft", "confidence": 0.8, "ballot": "agree"}
            return ({"content": [{"type": "text", "text": json.dumps(obj)}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        # critic
        obj = {"role": "critic", "summary": "looks ok", "confidence": 0.7, "ballot": "agree"}
        return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                 "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)

    srv._http_post_resilient = fake_post

    srv.tool_coordinate({
        "topic": "Pick a session-token strategy",
        "providers": ["openai", "anthropic", "xai"],
        "proposer": "anthropic",
        "critics":  ["openai", "xai"],
        "synthesizer": "anthropic",
        "session_id": sid2,
    })

    mem = srv._session_memory_list(sid2)
    by_kind: dict[str, list[str]] = {"decision": [], "fact": [], "open_question": []}
    for r in mem:
        by_kind[r["kind"]].append(r["content"])
    assert any("opaque tokens" in c.lower() for c in by_kind["decision"]), by_kind
    assert any("revocation"     in c.lower() for c in by_kind["fact"]), by_kind
    assert any("postgres"       in c.lower() for c in by_kind["fact"]), by_kind
    assert any("dissent: jwt"   in c.lower() for c in by_kind["open_question"]), by_kind
    assert any("dual-write"     in c.lower() for c in by_kind["open_question"]), by_kind

    # ------------------------------------------------------------------
    # 7) inject_session_memory:true prepends a block in coordinate
    # ------------------------------------------------------------------
    captured_prompts: list[str] = []
    def capture_post(url, h, b, **kw):
        # gather every user content from the body so we can verify injection
        for m in (b.get("messages") or []):
            if isinstance(m, dict) and m.get("role") == "user":
                captured_prompts.append(str(m.get("content", "")))
        # return a critic envelope (works for any role; schema validation
        # is tolerated to fail since we just want to inspect the prompt)
        obj = {"role": "critic", "summary": "k", "confidence": 0.5, "ballot": "agree"}
        if "anthropic.com" in url:
            return ({"content": [{"type": "text", "text": json.dumps(obj)}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({"choices": [{"message": {"content": json.dumps(obj)}}],
                 "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
    srv._http_post_resilient = capture_post

    srv.tool_coordinate({
        "topic":      "Round 2: refine the rollout plan",
        "providers":  ["openai", "anthropic", "xai"],
        "proposer":   "anthropic",
        "critics":    ["openai", "xai"],
        "synthesizer": "anthropic",
        "session_id": sid2,
        "inject_session_memory": True,
    })
    # At least one of the captured prompts should contain the session memory block.
    assert any("<session_memory>" in p for p in captured_prompts), captured_prompts[:1]
    assert any("Use opaque tokens" in p for p in captured_prompts)

    # ------------------------------------------------------------------
    # 8) Audit-gated anti-poisoning: failed audit marks all session memory stale
    # ------------------------------------------------------------------
    # Use a synthetic audit by calling _session_memory_mark_stale via the
    # actual tool_audit code path. Easier: drive tool_audit with a low-scoring
    # judge response so passed=false.
    audit_judge_response = json.dumps({
        "items": [
            {"id": "factual_grounding",     "score": 0.2, "rationale": "no"},
            {"id": "constraint_adherence",  "score": 0.2, "rationale": "no"},
            {"id": "no_pii_leak",           "score": 1.0, "rationale": "ok"},
            {"id": "internally_consistent", "score": 1.0, "rationale": "ok"},
            {"id": "covers_open_questions", "score": 1.0, "rationale": "ok"},
            {"id": "actionability",         "score": 1.0, "rationale": "ok"},
        ]
    })
    def fail_audit_post(url, h, b, **kw):
        if "anthropic.com" in url:
            return ({"content": [{"type": "text", "text": audit_judge_response}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({"choices": [{"message": {"content": audit_judge_response}}],
                 "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
    srv._http_post_resilient = fail_audit_post

    pre = srv._session_memory_list(sid2)
    assert len(pre) > 0, "expected memory written by coordinate"

    audit_res = srv.tool_audit({
        "session_id":            sid2,
        "output_to_audit":       "Bogus output that fails grounding + constraints.",
        "producing_panelists":   ["openai", "xai"],
        # Anthropic ends up as the auditor (outside the producing panel).
    })
    assert audit_res.get("passed") is False, audit_res
    # All previously-non-stale memory entries should now be marked stale.
    fresh = srv._session_memory_list(sid2)
    assert fresh == [], f"expected zero non-stale rows after failed audit, got {fresh}"
    # But include_stale should still show them
    with_stale = srv._session_memory_list(sid2, include_stale=True)
    assert len(with_stale) == len(pre)
    # Marker exposed on the audit response
    assert audit_res.get("session_memory_marked_stale", 0) == len(pre)

    # ------------------------------------------------------------------
    # 9) After staleness, injection block is empty
    # ------------------------------------------------------------------
    assert srv._session_memory_block(sid2) == ""

    print("OK: test_session_memory")
    return 0


if __name__ == "__main__":
    sys.exit(main())
