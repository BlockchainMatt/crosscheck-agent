#!/usr/bin/env python3
"""Py↔Py determinism harness.

The Phase-0.5 exit gate: prove that the Python crosscheck-agent server,
run TWICE on the same fixture, produces byte-identical output after
canonicalization. If this fails the canonicalizer has a gap that needs
patching BEFORE we ever start comparing TypeScript output against Python.

Strategy:
  1. Spawn the Python MCP server as a subprocess.
  2. Pipe a fixture (a list of JSON-RPC requests) through stdin.
  3. Capture stdout (the JSON-RPC responses).
  4. Repeat. Canonicalize both runs line-by-line. Byte-compare.

Each fixture call is restricted to tools that are pure-functional or
deterministic-once-canonicalized: list_providers, verify, ping-like
operations. No LLM calls (those have a separate cassette story in Phase 3).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Two-line preamble + one tool call per fixture.
def _handshake() -> list[dict]:
    return [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2024-11-05",
                      "capabilities": {},
                      "clientInfo": {"name": "py2py-parity", "version": "0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ]


# Each fixture is a sequence of MCP requests. Tool selection is restricted
# to deterministic-once-canonicalized tools so Py↔Py byte-equality is
# achievable without injection.
FIXTURES: dict[str, list[dict]] = {
    "list_providers": _handshake() + [
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
          "params": {"name": "list_providers", "arguments": {}}},
    ],
    "verify": _handshake() + [
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": {"name": "verify",
                      "arguments": {"checks": [
                          {"kind": "contains", "id": "c1",
                           "target_text": "the rain in spain",
                           "value": "rain"},
                          {"kind": "not_contains", "id": "c2",
                           "target_text": "hello world",
                           "value": "goodbye"},
                          {"kind": "regex_match", "id": "c3",
                           "target_text": "abc-123",
                           "value": r"^[a-z]+-\d+$"},
                          {"kind": "min_length", "id": "c4",
                           "target_text": "hello",
                           "value": 3},
                      ]}}},
    ],
    "verify_failures": _handshake() + [
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": {"name": "verify",
                      "arguments": {"checks": [
                          {"kind": "contains", "id": "fail1",
                           "target_text": "hello", "value": "goodbye"},
                          {"kind": "min_length", "id": "fail2",
                           "target_text": "hi", "value": 10},
                      ]}}},
    ],
}


def _run_server_once(fixture: list[dict], *, db_path: Path,
                     transcript_dir: Path) -> list[str]:
    """Spawn the Python server with isolated state, send the fixture
    via stdin, return the stdout lines. stderr is discarded (it has
    nondeterministic progress events)."""
    env = dict(os.environ)
    # Keep tests fully isolated from a user's real .crosscheck/ tree.
    env["CROSSCHECK_PRICING_PATH"] = str(ROOT / "config" / "pricing.json")

    stdin_payload = "\n".join(json.dumps(r) for r in fixture) + "\n"

    cmd = [sys.executable, str(ROOT / "servers" / "python" / "crosscheck_server.py")]
    proc = subprocess.run(
        cmd,
        input=stdin_payload,
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"python server exited {proc.returncode}\n"
            f"stderr (tail):\n{proc.stderr[-2000:]}"
        )
    return [ln for ln in proc.stdout.split("\n") if ln]


def _canonicalize_each(lines: list[str]) -> list[str]:
    sys.path.insert(0, str(ROOT / "scripts"))
    from canonicalize import canonicalize as _canon
    out: list[str] = []
    for ln in lines:
        try:
            doc = json.loads(ln)
        except json.JSONDecodeError:
            doc = ln
        out.append(_canon(doc))
    return out


def run_parity(fixture_name: str) -> tuple[bool, str]:
    """Run the named fixture twice and compare canonicalized stdouts.
    Returns (ok, diff_message_or_summary)."""
    if fixture_name not in FIXTURES:
        raise KeyError(
            f"unknown fixture {fixture_name!r}; have: {sorted(FIXTURES)}"
        )
    fixture = FIXTURES[fixture_name]

    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        run_a = _run_server_once(
            fixture, db_path=tmp_path / "a.sqlite",
            transcript_dir=tmp_path / "tx-a",
        )
        run_b = _run_server_once(
            fixture, db_path=tmp_path / "b.sqlite",
            transcript_dir=tmp_path / "tx-b",
        )

    canon_a = _canonicalize_each(run_a)
    canon_b = _canonicalize_each(run_b)

    if len(canon_a) != len(canon_b):
        return False, (
            f"line count differs: run_a={len(canon_a)} run_b={len(canon_b)}\n"
            f"  run_a last: {canon_a[-1] if canon_a else '<empty>'}\n"
            f"  run_b last: {canon_b[-1] if canon_b else '<empty>'}"
        )

    for i, (a, b) in enumerate(zip(canon_a, canon_b)):
        if a != b:
            return False, (
                f"diff at line {i + 1}:\n"
                f"  run_a: {a}\n"
                f"  run_b: {b}"
            )
    return True, f"OK: {len(canon_a)} line(s) byte-equal after canonicalization"


def _cli(argv: list[str]) -> int:
    targets = argv[1:] if len(argv) > 1 else sorted(FIXTURES)
    failures: list[str] = []
    for name in targets:
        try:
            ok, msg = run_parity(name)
        except KeyError as e:
            sys.stderr.write(f"{name}: {e}\n")
            failures.append(name)
            continue
        if ok:
            print(f"[{name}] {msg}")
        else:
            print(f"[{name}] FAIL\n{msg}")
            failures.append(name)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
