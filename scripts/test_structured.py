#!/usr/bin/env python3
"""Offline tests for output validator, JSON extractor, and structured synthesis.

Stubs a moderator provider that emits free text on first try and valid JSON
on retry, to prove the retry-with-feedback loop converges. Then asserts that
when a session_id is provided, claims are persisted to SQLite.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    # 1. _validate type checks: integer, number, string, boolean, array, object.
    assert srv._validate(42, {"type": "integer"}) == []
    assert srv._validate(True, {"type": "integer"})  # bool is rejected as integer
    assert srv._validate(1.5, {"type": "number"}) == []
    assert srv._validate(1, {"type": "number"}) == [],          "int satisfies number"
    assert srv._validate("hi", {"type": "string"}) == []
    assert srv._validate("hi", {"type": "string", "minLength": 5}) != []
    assert srv._validate("hi", {"type": "string", "enum": ["yes", "no"]}) != []

    # 2. _validate object: required, additionalProperties, nested.
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["a", "b"],
        "properties": {
            "a": {"type": "string"},
            "b": {"type": "integer", "minimum": 0},
            "c": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        },
    }
    assert srv._validate({"a": "x", "b": 1}, schema) == []
    assert srv._validate({"a": "x"}, schema) != [],             "missing required"
    assert srv._validate({"a": "x", "b": -1}, schema) != [],    "minimum"
    assert srv._validate({"a": "x", "b": 1, "z": 1}, schema) != [], "additionalProperties"
    assert srv._validate({"a": "x", "b": 1, "c": ["y"]}, schema) == []
    assert srv._validate({"a": "x", "b": 1, "c": []}, schema) != [], "minItems"

    # 3. StructuredSynthesis schema in tools.schema.json validates a real example.
    sample_ok = {
        "consensus": "Use bigserial keys.",
        "weighted_confidence": 0.84,
        "key_claims": [
            {"claim": "lower index size", "confidence": 0.9,
             "supporters": ["openai"], "dissenters": []},
        ],
        "dissent": [
            {"claim": "uuid v7 is also fine", "providers": ["xai"],
             "rationale": "globally unique"},
        ],
        "citations": ["postgresql.org"],
        "open_questions": ["does this hold under partitioning?"],
    }
    errs = srv._validate(sample_ok, srv._structured_synthesis_schema())
    assert errs == [],                                          f"valid sample failed: {errs}"

    # Missing required field.
    bad_missing = dict(sample_ok); bad_missing.pop("weighted_confidence")
    errs = srv._validate(bad_missing, srv._structured_synthesis_schema())
    assert any("weighted_confidence" in e for e in errs)

    # Confidence out of range.
    bad_range = json.loads(json.dumps(sample_ok))
    bad_range["weighted_confidence"] = 1.5
    errs = srv._validate(bad_range, srv._structured_synthesis_schema())
    assert any("maximum" in e for e in errs)

    # 4. _extract_json handles direct, fenced, and embedded JSON.
    assert srv._extract_json('{"x":1}') == {"x": 1}
    assert srv._extract_json('```json\n{"x":2}\n```') == {"x": 2}
    assert srv._extract_json("Here is the answer:\n```\n{\"x\":3}\n```\nDone.") == {"x": 3}
    assert srv._extract_json("noise {\"x\":4} more noise") == {"x": 4}
    assert srv._extract_json("[1,2,3]") == [1, 2, 3]
    assert srv._extract_json("not json at all") is None
    # Strings containing braces don't break the balanced scan.
    assert srv._extract_json('{"k":"a } b"}') == {"k": "a } b"}

    # 5. _request_structured: free-text first call, valid JSON on retry.
    tmp = Path(tempfile.mkdtemp(prefix="crosscheck-struct-"))
    try:
        srv.CFG = dict(srv.CFG)
        srv.CFG["session_db"]   = str(tmp / "sessions.sqlite3")
        srv.CFG["log_transcripts"] = False
        srv.CFG["events_log"]   = str(tmp / "events.ndjson")
        srv.CFG["cache"]        = {"enabled": False}
        srv.CFG["max_time_seconds"] = 10
        srv.CFG["token_cap"]    = 4096
        srv._DB_INIT_DONE = False

        attempts = {"n": 0}
        valid_payload = {
            "consensus": "Index by (tenant_id, created_at).",
            "weighted_confidence": 0.78,
            "key_claims": [{"claim": "narrow index", "confidence": 0.8}],
        }
        def flaky_send(messages, max_tokens, temperature):
            attempts["n"] += 1
            if attempts["n"] == 1:
                return ("Here's my take in prose, no JSON yet.", 1)
            return (json.dumps(valid_payload), 1)

        moderator = srv.Provider(name="anthropic", send=flaky_send, model="claude-test")
        deadline = time.monotonic() + 5
        obj, raw, errs = srv._request_structured(
            moderator,
            [{"role": "system", "content": "you are the moderator."},
             {"role": "user",   "content": "synthesize."}],
            srv._structured_synthesis_schema(),
            max_tokens=512, deadline=deadline, max_retries=1,
        )
        assert obj == valid_payload,                            f"got {obj!r}"
        assert errs == [],                                      f"errs: {errs}"
        assert attempts["n"] == 2,                              f"expected 2 calls, got {attempts['n']}"

        # 6. End-to-end: tool_debate(structured=True) persists claims.
        attempts["n"] = 0
        debate_payload = {
            "consensus": "Cache aside is the right call.",
            "weighted_confidence": 0.9,
            "key_claims": [
                {"claim": "fewer round trips", "confidence": 0.85,
                 "supporters": ["openai", "xai"]},
            ],
            "dissent": [
                {"claim": "but write-through is simpler", "providers": ["gemini"]},
            ],
            "open_questions": ["staleness budget?"],
        }
        # Two debaters + one moderator. Moderator's send returns valid JSON immediately.
        def debater_send(messages, max_tokens, temperature):
            return ("Debate turn.", 1)
        def mod_send(messages, max_tokens, temperature):
            return (json.dumps(debate_payload), 1)
        a = srv.Provider(name="alpha",     send=debater_send, model="a-1")
        b = srv.Provider(name="beta",      send=debater_send, model="b-1")
        m = srv.Provider(name="anthropic", send=mod_send,     model="claude-test")
        srv.ALL_PROVIDERS = {"alpha": a, "beta": b, "anthropic": m}
        srv.CFG["providers"] = ["alpha", "beta"]
        srv.CFG["moderator"] = "anthropic"
        srv.CFG["max_rounds"] = 1
        srv.CFG["provider_allowlist"] = None

        result = srv.tool_debate({
            "topic": "cache aside vs write-through",
            "providers": ["alpha", "beta"],
            "moderator": "anthropic",
            "max_rounds": 1,
            "session_id": "structured-1",
            "structured": True,
        })
        assert "synthesis_structured" in result,                f"missing structured synthesis: {result.keys()}"
        assert result["synthesis_structured"] == debate_payload
        assert "synthesis_errors" not in result or result["synthesis_errors"] == []

        # Claims persisted: 1 consensus + 1 key_claim + 1 dissent + 1 open_question = 4.
        claims = srv._session_claims("structured-1")
        kinds = sorted(c["kind"] for c in claims)
        assert kinds == ["consensus", "dissent", "open_question", "support"], f"got {kinds}"

        # 7. Validation failure path: moderator emits invalid JSON twice; we capture errors.
        bad_attempts = {"n": 0}
        def bad_mod_send(messages, max_tokens, temperature):
            bad_attempts["n"] += 1
            return ('{"consensus": "missing required fields"}', 1)
        m2 = srv.Provider(name="anthropic", send=bad_mod_send, model="claude-test")
        srv.ALL_PROVIDERS = {"alpha": a, "beta": b, "anthropic": m2}

        result2 = srv.tool_debate({
            "topic": "x", "providers": ["alpha", "beta"], "moderator": "anthropic",
            "max_rounds": 1, "session_id": "structured-2", "structured": True,
        })
        assert result2.get("synthesis_structured") is None
        assert result2.get("synthesis_errors"),                 "expected validation errors surfaced"
        assert any("weighted_confidence" in e for e in result2["synthesis_errors"])
        assert bad_attempts["n"] == 2,                          f"expected 2 attempts (initial + 1 retry), got {bad_attempts['n']}"

        print("all structured-synthesis tests passed")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
