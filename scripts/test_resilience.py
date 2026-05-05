#!/usr/bin/env python3
"""Offline tests for retries, error classification, and the rate limiter.

Stubs the lowest-level `_http_post` so no network is touched, then exercises
`_http_post_resilient`, `ProviderError` classification, and `_Bucket`.

Exit 0 on success.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))
    import crosscheck_server as srv

    # Tiny backoff for fast tests.
    srv.CFG = dict(srv.CFG)
    srv.CFG["retries"] = {"max_attempts": 3, "backoff_base_s": 0.01}
    fake_response = {"choices": [{"message": {"content": "ok"}}]}

    # 1. Transient 429 retries and then succeeds.
    calls = {"n": 0}
    def flaky_429(url, headers, body, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            raise srv.ProviderError("rate_limit", "fake 429", status=429,
                                    transient=True, retry_after_s=0.01)
        return fake_response
    srv._http_post = flaky_429
    deadline = time.monotonic() + 5
    resp, attempts = srv._http_post_resilient("u", {}, {}, 1.0, deadline)
    assert attempts == 2,                                f"expected 2 attempts, got {attempts}"
    assert resp == fake_response

    # 2. Permanent 401 raises immediately, no retry.
    calls["n"] = 0
    def auth_fail(url, headers, body, timeout):
        calls["n"] += 1
        raise srv.ProviderError("auth", "fake 401", status=401, transient=False)
    srv._http_post = auth_fail
    try:
        srv._http_post_resilient("u", {}, {}, 1.0, time.monotonic() + 5)
        return _fail("expected ProviderError(auth)")
    except srv.ProviderError as e:
        assert e.kind == "auth",                         f"got kind={e.kind}"
        assert calls["n"] == 1,                          f"auth must not retry, got {calls['n']} calls"

    # 3. Repeated 5xx exhausts retries and surfaces the server error.
    calls["n"] = 0
    def always_500(url, headers, body, timeout):
        calls["n"] += 1
        raise srv.ProviderError("server", "fake 502", status=502, transient=True)
    srv._http_post = always_500
    try:
        srv._http_post_resilient("u", {}, {}, 1.0, time.monotonic() + 5)
        return _fail("expected ProviderError(server) after exhausting retries")
    except srv.ProviderError as e:
        assert e.kind == "server"
        assert calls["n"] == 3,                          f"expected 3 attempts, got {calls['n']}"

    # 4. Rate limiter token bucket: capacity 2, refill 1/s — 3rd call must block, 4th must time out.
    bucket = srv._Bucket(capacity=2, refill_per_sec=1.0)
    deadline = time.monotonic() + 0.05  # 50ms — too short for a 1/s refill
    assert bucket.acquire(deadline) is True
    assert bucket.acquire(deadline) is True
    assert bucket.acquire(deadline) is False,            "3rd acquire should fail under tight deadline"

    # 5. _ask_one wraps a ProviderError into a structured answer with error_kind.
    def stub_send(messages, max_tokens, temperature):
        raise srv.ProviderError("rate_limit", "boom", status=429, transient=True, retry_after_s=2.5)
    bad = srv.Provider(name="stub", send=stub_send, model="stub-1")
    srv.CFG["max_time_seconds"] = 5
    srv.CFG["token_cap"] = 1024
    srv.CFG["cache"] = {"enabled": False}  # disable cache for this assertion
    deadline = time.monotonic() + 5
    ans = srv._ask_one(bad, [{"role": "user", "content": "hi"}], deadline, 256)
    assert ans["error_kind"] == "rate_limit",            f"got {ans!r}"
    assert ans["retry_after_s"] == 2.5
    assert ans["cache_hit"] is False
    assert ans["attempts"] == 0

    print("all resilience tests passed")
    return 0


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
