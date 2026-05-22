#!/usr/bin/env python3
"""Regression test: claude-opus-4-7 (and its dated variants) reject the
`temperature` parameter with HTTP 400. The Anthropic adapter must omit it
for those models while still sending it for sonnet/haiku/older opus.

Exit 0 on success.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    # 1. Prefix detection: only opus-4-7 hits.
    cases = [
        ("claude-opus-4-5",            True),
        ("claude-opus-4-6",            True),
        ("claude-opus-4-7",            False),
        ("claude-opus-4-7-20251224",   False),    # dated variant
        ("claude-sonnet-4-6",          True),
        ("claude-haiku-4-5",           True),
        ("claude-3-5-sonnet",          True),
    ]
    for model, expected in cases:
        got = srv._supports_temperature("anthropic", model)
        assert got is expected, f"_supports_temperature(anthropic, {model!r}) = {got}, want {expected}"

    # 2. The adapter must actually omit `temperature` from the HTTP body for
    #    opus-4-7, and include it for opus-4-5. Stub `_http_post_resilient` to
    #    capture the body without touching the network.
    captured: dict = {}
    def fake_resilient(url, headers, body, timeout, deadline):
        captured["body"] = body
        return ({
            "content": [{"type": "text", "text": "ok"}],
            "usage":   {"input_tokens": 10, "output_tokens": 5},
        }, 1)

    srv._http_post_resilient = fake_resilient
    srv.ENV = dict(srv.ENV)
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"

    # opus-4-7 (and a dated variant) -> no `temperature` key.
    for model in ("claude-opus-4-7", "claude-opus-4-7-20251224"):
        srv.ENV["ANTHROPIC_MODEL"] = model
        prov = srv.anthropic_provider()
        assert prov is not None, "factory should build provider"
        captured.clear()
        prov.send([{"role": "user", "content": "hi"}], 256, 0.4, purpose="worker")
        assert "temperature" not in captured["body"], \
            f"{model}: body must NOT include `temperature` (got {captured['body']!r})"
        assert captured["body"].get("model") == model
        assert "max_tokens" in captured["body"]

    # opus-4-5 -> `temperature` present and equal to what we passed.
    srv.ENV["ANTHROPIC_MODEL"] = "claude-opus-4-5"
    prov = srv.anthropic_provider()
    captured.clear()
    prov.send([{"role": "user", "content": "hi"}], 256, 0.4, purpose="worker")
    assert captured["body"].get("temperature") == 0.4, \
        f"opus-4-5: temperature should be present (got {captured['body']!r})"

    # haiku still sends temperature.
    srv.ENV["ANTHROPIC_MODEL"] = "claude-haiku-4-5"
    prov = srv.anthropic_provider()
    captured.clear()
    prov.send([{"role": "user", "content": "hi"}], 256, 0.7, purpose="worker")
    assert captured["body"].get("temperature") == 0.7

    print("OK: test_anthropic_temperature")
    return 0


if __name__ == "__main__":
    sys.exit(main())
