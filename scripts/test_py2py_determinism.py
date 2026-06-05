#!/usr/bin/env python3
"""Py↔Py determinism test — Phase 0.5 exit gate.

Runs `scripts/parity_py2py.py` against every fixture and asserts every
one comes back byte-equal after canonicalization. Failure here means the
canonicalizer has a gap and must be patched in BOTH:
  - servers/typescript/src/core/canonicalize.ts
  - scripts/canonicalize.py
before any cross-language parity test can be trusted.

Wires into the existing `for t in scripts/test_*.py; do ...; done` runner.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    from parity_py2py import FIXTURES, run_parity

    # 1) Canonicalizer unit tests — pin down behavior. Mirrors the TS
    #    test/unit/canonicalize.test.ts assertions so any drift between
    #    the two halves fails loudly here.
    from canonicalize import canonicalize as _canon

    # Sorted keys
    assert _canon({"b": 1, "a": 2}) == '{"a":2,"b":1}'
    # Transient stripping
    assert _canon({"ok": True, "wall_ms": 99, "ended_at": "2026-05-25T19:43:54Z"}) \
        == '{"ok":true}'
    # ISO timestamp
    assert _canon("2026-05-25T19:43:54Z") == '"<TS>"'
    assert _canon("2026-05-25T19:43:54.123Z") == '"<TS>"'
    # UUID positional token
    u = "abcdef01-2345-4678-9abc-def012345678"
    assert _canon({"a": u, "b": u}) == '{"a":"<UUID:1>","b":"<UUID:1>"}'
    # Canary
    assert _canon("CC_CANARY_DEADBEEF") == '"<CANARY:1>"'
    # Session id
    assert _canon("s-7af3") == '"<SID:1>"'
    # Float rounding (6 dp default)
    assert _canon(1 / 3) == '0.333333'
    # 0.1 + 0.2 rounds clean to 0.3
    assert _canon(0.1 + 0.2) == '0.3'
    # Integers stay integers
    assert _canon(42) == '42'
    # Inline tokens
    assert _canon({"log": f"id {u} leak CC_CANARY_ABCDEF"}) \
        == '{"log":"id <UUID:1> leak <CANARY:1>"}'
    # NaN / Inf -> null
    assert _canon(float("nan")) == 'null'
    assert _canon(float("inf")) == 'null'

    print("OK: canonicalizer unit checks (12)")

    # 2) Py↔Py byte-equal parity on every fixture.
    failures: list[str] = []
    for name in sorted(FIXTURES):
        ok, msg = run_parity(name)
        if ok:
            print(f"OK: parity[{name}] — {msg}")
        else:
            print(f"FAIL: parity[{name}]\n{msg}")
            failures.append(name)

    if failures:
        print(f"FAIL: {len(failures)} fixture(s) had divergent canonical output: "
              f"{failures}", file=sys.stderr)
        return 1

    print("OK: test_py2py_determinism")
    return 0


if __name__ == "__main__":
    sys.exit(main())
