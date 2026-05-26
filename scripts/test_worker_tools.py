#!/usr/bin/env python3
"""Tests for the worker tool-use loop (bounded inner ReAct).

Covers:
  - Happy path: worker emits one fetch call, gets back wrapped result,
    produces a final answer
  - Hop budget exhaustion: a 3rd request gets a refusal and the worker
    is given one more round to produce a final answer
  - Disallowed tool name (e.g. 'coordinate') returns a refusal payload
  - Malformed <tool_call> JSON returns a parse_error refusal that the
    worker can correct on the next hop
  - Empty / missing worker_tools = identity behavior (no system hint,
    no inner_tool_calls field)
  - tool_confer accepts worker_tools and surfaces the accepted/rejected
    split back to the caller
  - Inner fetch result is wrapped in <untrusted_input> so injection
    instructions are neutralized
  - Recursive tools (`coordinate`, `audit`, `solve`, etc.) are
    rejected even if the worker requests them
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
        "openai":    {"gpt-test":    {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.CFG["prompt_adapters"] = {"enabled": False}    # keep wire stable
    srv.CFG["fetch"] = {"url_allowlist": ["https://example.com/"]}
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ALL_PROVIDERS = srv.build_providers()
    srv.CFG["providers"] = ["openai", "anthropic"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # Test fixtures
    # ------------------------------------------------------------------
    # Capture every wire body so we can inspect the message history that
    # each provider call sees (this is what proves the loop is wiring
    # tool_result blocks back into the conversation).
    bodies: list[dict] = []

    # Programmable per-provider response queues. Pop from front each call.
    openai_responses: list[str] = []
    anthropic_responses: list[str] = []
    # Captured URLs so we can assert fetch was actually invoked.
    fetched_urls: list[str] = []

    def fake_post(url, h, b, **kw):
        bodies.append({"url": url, "body": b})
        if "openai.com" in url:
            text = openai_responses.pop(0) if openai_responses else "DONE."
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        if "anthropic.com" in url:
            text = anthropic_responses.pop(0) if anthropic_responses else "DONE."
            return ({"content": [{"type": "text", "text": text}],
                     "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post

    # Replace tool_fetch with a deterministic stub so we don't need real HTTP.
    real_tool_fetch = srv.tool_fetch
    def fake_tool_fetch(args):
        fetched_urls.append(args.get("url", ""))
        return {
            "tool": "fetch",
            "url":  args.get("url"),
            "status": "ok",
            "content_excerpt": "RATE_LIMIT_RPS = 100; BURST = 20.",
        }
    srv.tool_fetch = fake_tool_fetch

    # ------------------------------------------------------------------
    # 1) _extract_tool_call basics (regex + JSON validation)
    # ------------------------------------------------------------------
    call, err = srv._extract_tool_call(
        'Some thinking.\n<tool_call>{"name":"fetch","args":{"url":"https://example.com/x"}}</tool_call>\nMore.'
    )
    assert err is None and call is not None, (call, err)
    assert call["name"] == "fetch"
    assert call["args"]["url"] == "https://example.com/x"

    # No tag → (None, None)
    call, err = srv._extract_tool_call("Just a plain answer.")
    assert call is None and err is None

    # Tag with malformed JSON → (None, error_msg)
    call, err = srv._extract_tool_call("<tool_call>{not json</tool_call>")
    assert call is None and isinstance(err, str) and "JSON" in err, (call, err)

    # ------------------------------------------------------------------
    # 2) Allowlist gates rejected tools
    # ------------------------------------------------------------------
    refusal = srv._worker_tools_dispatch({"name": "coordinate", "args": {}},
                                          session_id="s")
    assert '"refused": true' in refusal, refusal
    assert "coordinate" in refusal
    refusal = srv._worker_tools_dispatch({"name": "solve",      "args": {}},
                                          session_id="s")
    assert '"refused": true' in refusal, refusal

    # ------------------------------------------------------------------
    # 3) Happy path: one fetch call, then final answer
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        # First turn: emit tool call
        '<tool_call>{"name": "fetch", "args": {"url": "https://example.com/spec"}}</tool_call>',
        # Second turn (after tool result is re-prompted): final answer
        "Based on the fetched spec, the rate limit is 100 RPS with burst 20.",
    ]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "You are helpful."},
         {"role": "user",   "content": "What's the rate limit per the spec?"}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="happy",
    )
    assert "Based on the fetched spec" in ans["response"], ans
    assert ans["inner_tool_calls"] == [{"hop": 1, "name": "fetch", "status": "ok"}], ans
    assert fetched_urls == ["https://example.com/spec"], fetched_urls
    # Second wire call must contain the wrapped tool_result.
    second_call_body = bodies[-1]["body"]
    user_msgs = [m for m in second_call_body["messages"] if m["role"] == "user"]
    assert any('<tool_result name="fetch">' in m["content"] for m in user_msgs), user_msgs
    assert any('<untrusted_input>' in m["content"] for m in user_msgs), user_msgs
    # Usage was summed across both calls.
    assert ans["usage"]["completion_tokens"] >= 20, ans["usage"]

    # ------------------------------------------------------------------
    # 4) Hop budget: 3 consecutive tool_call requests → refusal + final
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        '<tool_call>{"name": "fetch", "args": {"url": "https://example.com/a"}}</tool_call>',
        '<tool_call>{"name": "fetch", "args": {"url": "https://example.com/b"}}</tool_call>',
        '<tool_call>{"name": "fetch", "args": {"url": "https://example.com/c"}}</tool_call>',
        "Final answer after exhausting tool budget.",
    ]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "You are helpful."},
         {"role": "user",   "content": "Need multiple sources."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="budget",
    )
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    # First 2 calls execute, 3rd is rejected with hop_budget_exhausted.
    assert statuses == ["ok", "ok", "hop_budget_exhausted"], statuses
    # Only 2 fetches actually happened.
    assert len(fetched_urls) == 2, fetched_urls
    assert "Final answer" in ans["response"]

    # ------------------------------------------------------------------
    # 5) Disallowed tool name → refusal, worker still completes
    # ------------------------------------------------------------------
    bodies.clear(); fetched_urls.clear()
    openai_responses[:] = [
        '<tool_call>{"name": "coordinate", "args": {"topic": "evil"}}</tool_call>',
        "Sorry, falling back. Here is my best answer.",
    ]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "user", "content": "Try to recursively invoke coordinate."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch", "verify"], session_id="evil",
    )
    assert ans["inner_tool_calls"] == [{"hop": 1, "name": "coordinate", "status": "refused"}]
    assert "best answer" in ans["response"]
    # Critical: coordinate was NEVER actually invoked.
    # (We can't easily inspect that, but the lack of an additional bodies
    # entry for tool_coordinate's downstream provider calls is the test —
    # only the 2 openai calls happened.)
    assert sum(1 for b in bodies if "openai.com" in b["url"]) == 2, bodies

    # ------------------------------------------------------------------
    # 6) Malformed JSON → parse_error refusal, worker can correct
    # ------------------------------------------------------------------
    bodies.clear()
    openai_responses[:] = [
        '<tool_call>{not json at all</tool_call>',
        '<tool_call>{"name": "fetch", "args": {"url": "https://example.com/x"}}</tool_call>',
        "Recovered and answered.",
    ]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "user", "content": "Show recovery from a bad emission."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="recover",
    )
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    assert statuses == ["parse_error", "ok"], statuses
    assert "Recovered" in ans["response"]

    # ------------------------------------------------------------------
    # 7) Empty worker_tools = identity behavior (no system hint, no
    #    inner_tool_calls)
    # ------------------------------------------------------------------
    bodies.clear()
    openai_responses[:] = ["Plain answer, no tool calls."]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "system", "content": "You are helpful."},
         {"role": "user",   "content": "Hi."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=[], session_id="empty",
    )
    assert ans["response"] == "Plain answer, no tool calls."
    assert "inner_tool_calls" not in ans, ans
    # Verify the system prompt was NOT augmented with the tool hint.
    sent = bodies[-1]["body"]
    sys_msg = next((m for m in sent["messages"] if m["role"] == "system"), None)
    assert sys_msg is not None
    assert "<tool_call>" not in sys_msg["content"], sys_msg["content"]

    # ------------------------------------------------------------------
    # 8) tool_confer accepts worker_tools and reports accepted/rejected
    # ------------------------------------------------------------------
    bodies.clear()
    openai_responses[:] = ["No tools needed; here is my answer."]
    anthropic_responses[:] = ["Anthropic answer, no tools."]
    res = srv.tool_confer({
        "question":     "Quick question",
        "providers":    ["openai", "anthropic"],
        "worker_tools": ["fetch", "audit", "coordinate", "verify"],
        "session_id":   "confer-worker",
    })
    assert res["worker_tools"] == {
        "accepted":   ["fetch", "verify"],
        "rejected":   ["audit", "coordinate"],
        "hop_budget": 2,
    }, res["worker_tools"]
    # No worker emitted tool calls so behavior is single-shot for both.

    # ------------------------------------------------------------------
    # 9) Inner result is wrapped with neutralization (untrusted_input)
    # ------------------------------------------------------------------
    # The wrapper itself is what we check; the regex-neutralized phrase
    # check is in test_safety.py. Here we just confirm the shape.
    wrapped = srv._wrap_tool_result("fetch", "some content here")
    assert wrapped.startswith('<tool_result name="fetch">'), wrapped
    assert "<untrusted_input>" in wrapped and "</untrusted_input>" in wrapped
    assert wrapped.endswith("</tool_result>")

    # ------------------------------------------------------------------
    # 10) Allowlist is the ONLY way in: every LLM-spawning tool refused
    # ------------------------------------------------------------------
    for name in ("coordinate", "audit", "solve", "delegate", "create",
                  "create_cheap", "orchestrate", "debate", "plan", "review",
                  "triangulate", "pick", "critique", "explain", "scoreboard",
                  "recommend_panel", "recall", "session_memory", "bench",
                  "list_providers", "update_crosscheck"):
        refusal = srv._worker_tools_dispatch({"name": name, "args": {}},
                                              session_id="rl")
        assert '"refused": true' in refusal, (name, refusal)

    # Restore real tool_fetch (defensive; pytest-style state cleanup).
    srv.tool_fetch = real_tool_fetch

    print("OK: test_worker_tools")
    return 0


if __name__ == "__main__":
    sys.exit(main())
