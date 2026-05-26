#!/usr/bin/env python3
"""Tests for provider-specific prompt adapters.

Covers:
  - Reasoning-model preamble strip removes 'let's think step by step' etc.
  - Anthropic XML wrap applies only when content is long and not already tagged
  - Non-Anthropic providers don't get the XML wrap
  - Non-reasoning providers don't get the preamble strip
  - CFG.prompt_adapters.enabled=false short-circuits everything
  - _adapt_messages is invoked from _ask_one and cache keys reflect the adapted prompt
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
        "openai":    {"gpt-test":          {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005},
                       "gpt-5":            {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0005}},
        "anthropic": {"claude-test":       {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003},
                       "claude-opus-4-7":  {"prompt_per_1k": 0.015,  "completion_per_1k": 0.075,  "cached_per_1k": 0.0015}},
        "xai":       {"grok-test":         {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
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
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    # ------------------------------------------------------------------
    # 1) Preamble strip targets reasoning-class models only
    # ------------------------------------------------------------------
    msgs = [
        {"role": "system", "content": "You are helpful. Let's think step by step before answering."},
        {"role": "user",   "content": "Please think out loud about this design."},
    ]
    # Reasoning model: preamble should be stripped.
    out, info = srv._adapt_messages("openai", "gpt-5", "worker", msgs)
    assert any(a.startswith("reasoning_preamble_strip") for a in info["applied"]), info
    assert "think step by step" not in out[0]["content"].lower()
    assert "think out loud" not in out[1]["content"].lower()
    # Non-reasoning model: preamble preserved.
    out, info = srv._adapt_messages("openai", "gpt-test", "worker", msgs)
    assert not any(a.startswith("reasoning_preamble_strip") for a in info["applied"]), info
    assert "think step by step" in out[0]["content"].lower()

    # ------------------------------------------------------------------
    # 2) Anthropic XML wrap applies on long content, untagged
    # ------------------------------------------------------------------
    long_body = "Design the auth migration. " * 40   # ~ 1000 chars
    msgs = [
        {"role": "system", "content": "You are an architect."},
        {"role": "user",   "content": long_body},
    ]
    out, info = srv._adapt_messages("anthropic", "claude-test", "worker", msgs)
    assert "anthropic_xml_wrap" in info["applied"], info
    user_content = out[1]["content"]
    assert "<task>" in user_content and "</task>" in user_content
    assert "<instructions>" in user_content
    # The original system message survives unchanged (Anthropic's send()
    # reads body["system"] from it; the wrap only restructures the user).
    assert out[0]["content"] == "You are an architect."

    # Short body: no wrap.
    out, info = srv._adapt_messages("anthropic", "claude-test", "worker",
                                     [{"role": "user", "content": "hi"}])
    assert "anthropic_xml_wrap" not in info["applied"], info

    # Already tagged body: no wrap (don't re-wrap caller's structure).
    pre_tagged = "<task>existing</task>" + ("x" * 1200)
    out, info = srv._adapt_messages("anthropic", "claude-test", "worker",
                                     [{"role": "user", "content": pre_tagged}])
    assert "anthropic_xml_wrap" not in info["applied"], info

    # Non-anthropic provider: no XML wrap even on long body.
    out, info = srv._adapt_messages("openai", "gpt-test", "worker",
                                     [{"role": "user", "content": long_body}])
    assert "anthropic_xml_wrap" not in info["applied"], info

    # ------------------------------------------------------------------
    # 3) Reasoning Anthropic gets BOTH preamble strip + XML wrap
    # ------------------------------------------------------------------
    msgs = [
        {"role": "system", "content": "Think step by step."},
        {"role": "user",   "content": long_body},
    ]
    out, info = srv._adapt_messages("anthropic", "claude-opus-4-7", "worker", msgs)
    applied = set(info["applied"])
    assert any(a.startswith("reasoning_preamble_strip") for a in applied), info
    assert "anthropic_xml_wrap" in applied, info

    # ------------------------------------------------------------------
    # 4) Toggle: CFG.prompt_adapters.enabled=false short-circuits
    # ------------------------------------------------------------------
    srv.CFG["prompt_adapters"] = {"enabled": False}
    out, info = srv._adapt_messages("anthropic", "claude-opus-4-7", "worker",
                                     [{"role": "system", "content": "Let's think step by step"},
                                      {"role": "user",   "content": long_body}])
    assert info["applied"] == [], info
    # System content untouched; user content untouched.
    assert "think step by step" in out[0]["content"].lower()
    assert "<task>" not in out[1]["content"]
    srv.CFG["prompt_adapters"] = {"enabled": True}

    # ------------------------------------------------------------------
    # 5) End-to-end: _ask_one applies adapters before send
    # ------------------------------------------------------------------
    srv.ENV = dict(srv.ENV)
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-opus-4-7"
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-5"
    srv.ALL_PROVIDERS = srv.build_providers()

    captured = []
    def fake_post(url, h, b, **kw):
        captured.append({"url": url, "body": b})
        if "anthropic.com" in url:
            return ({"content": [{"type": "text", "text": "ok"}],
                     "usage": {"input_tokens": 20, "output_tokens": 5}}, 1)
        return ({"choices": [{"message": {"content": "ok"}}],
                 "usage": {"prompt_tokens": 20, "completion_tokens": 5}}, 1)
    srv._http_post_resilient = fake_post

    long_body = "Plan the auth migration. " * 50  # ~1250 chars
    import time as _t
    srv._ask_one(srv.ALL_PROVIDERS["anthropic"],
                 [{"role": "system", "content": "Let's think step by step before answering."},
                  {"role": "user",   "content": long_body}],
                 deadline=_t.monotonic() + 10, max_tokens=2048, purpose="worker")
    sent = captured[-1]["body"]
    # Anthropic send() pulls system into body["system"]; user is the last entry of messages.
    user_msg = sent["messages"][-1]["content"]
    assert "<task>" in user_msg, user_msg
    # The system message was stripped of the preamble.
    sys_block = sent.get("system") or ""
    assert "think step by step" not in sys_block.lower(), sys_block

    # ------------------------------------------------------------------
    # 6) OpenAI reasoning model: preamble stripped from system
    # ------------------------------------------------------------------
    captured.clear()
    srv._ask_one(srv.ALL_PROVIDERS["openai"],
                 [{"role": "system", "content": "Let's think step by step."},
                  {"role": "user",   "content": "What is 2+2?"}],
                 deadline=_t.monotonic() + 10, max_tokens=2048, purpose="worker")
    sent = captured[-1]["body"]
    sys_msg = next((m for m in sent["messages"] if m["role"] == "system"), None)
    assert sys_msg, sent
    assert "think step by step" not in sys_msg["content"].lower(), sys_msg

    print("OK: test_prompt_adapters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
