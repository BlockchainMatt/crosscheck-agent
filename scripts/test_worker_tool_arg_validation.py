#!/usr/bin/env python3
"""Tests for gateway-level input-schema validation of worker inner-tool
calls.

Today the gateway only checks the allowlist; bad args fall through to
the inner tool which returns its own ad-hoc error envelope. The fix:
validate args against the inner tool's `inputSchema` at the gateway
BEFORE dispatch, and surface a structured refusal (`schema_error`
field on the refusal payload) so the worker can self-correct.
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
    srv._CONFIG_PIN_STARTUP_DONE = True

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ALL_PROVIDERS = srv.build_providers()
    srv.CFG["providers"] = ["openai", "anthropic"]

    # Track whether the inner tools were actually called: we should NEVER
    # reach them with invalid args, because the gateway short-circuits.
    fetch_calls: list[dict] = []
    verify_calls: list[dict] = []
    real_fetch  = srv.tool_fetch
    real_verify = srv.tool_verify

    def fake_fetch(args):
        fetch_calls.append(dict(args))
        return {"tool": "fetch", "url": args.get("url"),
                "status": "ok", "content_excerpt": "ok"}

    def fake_verify(args):
        verify_calls.append(dict(args))
        return {"tool": "verify", "all_passed": True,
                "checks_run": len(args.get("checks") or []),
                "results": [], "summary": "ok"}

    srv.tool_fetch  = fake_fetch
    srv.tool_verify = fake_verify

    # ------------------------------------------------------------------
    # 1) Missing required field on `fetch` (no `url`) -> refusal
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch({"name": "fetch", "args": {}},
                                      session_id="sess-1")
    assert '"refused": true' in res, res
    payload = json.loads(res.split("<untrusted_input>")[1].split("</untrusted_input>")[0].strip())
    assert payload["tool"] == "fetch"
    assert payload.get("schema_error"), payload
    assert "url" in payload["schema_error"].lower(), payload["schema_error"]
    assert fetch_calls == [], "inner fetch must NOT be called when validation fails"

    # ------------------------------------------------------------------
    # 2) Wrong type on `fetch.url` (integer not string) -> refusal
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch({"name": "fetch", "args": {"url": 12345}},
                                      session_id="sess-2")
    assert '"refused": true' in res
    payload = json.loads(res.split("<untrusted_input>")[1].split("</untrusted_input>")[0].strip())
    assert payload.get("schema_error"), payload
    assert "url" in payload["schema_error"].lower() and "string" in payload["schema_error"].lower(), payload["schema_error"]
    assert fetch_calls == []

    # ------------------------------------------------------------------
    # 3) `verify` missing required `checks` -> refusal
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch({"name": "verify", "args": {}},
                                      session_id="sess-3")
    assert '"refused": true' in res
    payload = json.loads(res.split("<untrusted_input>")[1].split("</untrusted_input>")[0].strip())
    assert payload["tool"] == "verify"
    assert "checks" in payload.get("schema_error", "").lower(), payload
    assert verify_calls == []

    # ------------------------------------------------------------------
    # 4) `verify.checks` not a list -> refusal
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch(
        {"name": "verify", "args": {"checks": "not-a-list"}},
        session_id="sess-4")
    assert '"refused": true' in res
    payload = json.loads(res.split("<untrusted_input>")[1].split("</untrusted_input>")[0].strip())
    assert "checks" in payload.get("schema_error", "").lower(), payload
    assert "array" in payload["schema_error"].lower(), payload["schema_error"]
    assert verify_calls == []

    # ------------------------------------------------------------------
    # 5) Unknown argument on `fetch` -> refusal (additionalProperties=false)
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch(
        {"name": "fetch", "args": {"url": "https://example.com/", "evil_arg": 1}},
        session_id="sess-5")
    # Refusal expected because the fetch schema sets additionalProperties=false.
    # If the schema doesn't (some shapes don't), we relax to "either pass or refuse".
    schema = srv._worker_tool_input_schema("fetch")
    if schema.get("additionalProperties") is False:
        assert '"refused": true' in res, res
        assert fetch_calls == []  # never reached the inner tool
    else:
        # Schema is permissive on extras — gateway should let it through.
        assert '"refused": true' not in res

    # ------------------------------------------------------------------
    # 6) VALID args on fetch still dispatch correctly (regression)
    # ------------------------------------------------------------------
    fetch_calls.clear()
    res = srv._worker_tools_dispatch(
        {"name": "fetch", "args": {"url": "https://example.com/spec"}},
        session_id="sess-ok")
    assert '"refused": true' not in res, res
    assert len(fetch_calls) == 1
    assert fetch_calls[0]["url"] == "https://example.com/spec"
    # session_id was injected
    assert fetch_calls[0].get("session_id") == "sess-ok"

    # ------------------------------------------------------------------
    # 7) VALID args on verify still dispatch (regression)
    # ------------------------------------------------------------------
    verify_calls.clear()
    res = srv._worker_tools_dispatch(
        {"name": "verify",
         "args": {"checks": [{"kind": "contains",
                                "id": "x",
                                "target_text": "hi",
                                "value": "hi"}]}},
        session_id="sess-ok-2")
    assert '"refused": true' not in res, res
    assert len(verify_calls) == 1

    # ------------------------------------------------------------------
    # 8) Allowlist denial still works (regression — checked BEFORE schema)
    # ------------------------------------------------------------------
    res = srv._worker_tools_dispatch(
        {"name": "coordinate", "args": {"topic": "evil"}},
        session_id="sess-deny")
    payload = json.loads(res.split("<untrusted_input>")[1].split("</untrusted_input>")[0].strip())
    assert payload["refused"] is True
    # No schema_error on an allowlist refusal — the gateway never even
    # got to the schema check.
    assert "schema_error" not in payload, payload

    # ------------------------------------------------------------------
    # 9) End-to-end: worker emits invalid call, gets refusal with
    #    schema_error, recovers on next hop
    # ------------------------------------------------------------------
    openai_responses: list[str] = []
    bodies: list[dict] = []
    def fake_post(url, h, b, **kw):
        bodies.append({"url": url, "body": b})
        if "openai.com" in url:
            text = openai_responses.pop(0) if openai_responses else "DONE."
            return ({"choices": [{"message": {"content": text}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({}, 1)
    srv._http_post_resilient = fake_post

    fetch_calls.clear()
    openai_responses[:] = [
        # First emission: invalid (missing url)
        '<tool_call>{"name":"fetch","args":{}}</tool_call>',
        # Second emission: valid
        '<tool_call>{"name":"fetch","args":{"url":"https://example.com/x"}}</tool_call>',
        "Recovered with the data.",
    ]
    ans = srv._ask_one_with_tools(
        srv.ALL_PROVIDERS["openai"],
        [{"role": "user", "content": "Try again."}],
        deadline=__import__("time").monotonic() + 30,
        max_tokens=2048, purpose="worker",
        worker_tools=["fetch"], session_id="recover",
    )
    statuses = [c["status"] for c in ans["inner_tool_calls"]]
    # Both calls counted as "refused" / "ok" but only one real fetch fired.
    assert statuses == ["refused", "ok"], statuses
    assert len(fetch_calls) == 1, fetch_calls
    assert "Recovered" in ans["response"]
    # Verify the second-turn re-prompt embedded the schema_error so the
    # worker had something concrete to fix.
    user_msgs = []
    for b in bodies:
        user_msgs.extend(m.get("content", "") for m in b["body"]["messages"]
                          if m["role"] == "user")
    refusal_msgs = [m for m in user_msgs if "schema_error" in m]
    assert refusal_msgs, "expected the schema_error refusal to be re-prompted"

    srv.tool_fetch  = real_fetch
    srv.tool_verify = real_verify
    print("OK: test_worker_tool_arg_validation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
