#!/usr/bin/env python3
"""Cross-language schema parity test — Phase 1 exit gate.

Creates a fresh database via the Python server's `_db_init` and another
via the TypeScript adapter's `migrate()`, computes the canonical schema
string for each, and asserts byte-equal. Failure here means the TS
migration drifted from the Python schema and tools built on top of the
TS storage will silently store/query data differently from Python.

Mirrors are:
  - servers/typescript/src/adapters/storage/schema.ts (TS canonicalizer)
  - scripts/canonicalize_schema.py                    (Python mirror)
  - servers/typescript/src/adapters/storage/migrations/0001_init.ts
  - servers/python/crosscheck_server.py:_db_init

Skipped (with explicit OK message) if the TS toolchain isn't installed.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS_DIR = ROOT / "servers" / "typescript"


def _make_python_db(db_path: Path) -> None:
    """Spawn the Python server briefly so its _db_init runs against
    `db_path`. Easiest way: import the server module in a subprocess
    with CFG.session_db pointing at our path, then call _db_init."""
    # Python creates `fetch_egress` lazily (on the first fetch), so a
    # cold `_db_init()` alone doesn't include it. The TS migration creates
    # it eagerly. The schemas are equivalent ONCE BOTH SIDES HAVE BEEN
    # FULLY INITIALIZED; the parity test must trigger Python's lazy init
    # before comparing.
    code = f"""
import sys, os
sys.path.insert(0, {repr(str(ROOT / 'servers' / 'python'))})
import crosscheck_server as srv
srv.CFG = dict(srv.CFG)
srv.CFG['session_db'] = {repr(str(db_path))}
srv._DB_INIT_DONE = False
srv._FTS5_AVAILABLE = None
srv._db_init()
srv._fetch_egress_init()
"""
    env = dict(os.environ)
    env["CROSSCHECK_PRICING_PATH"] = str(ROOT / "config" / "pricing.json")
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"python _db_init failed: rc={proc.returncode}\n"
            f"stderr:\n{proc.stderr}\n"
            f"stdout:\n{proc.stdout}"
        )


def _make_ts_db(db_path: Path) -> bool:
    """Build the TS package if needed, then run the dump-schema helper
    against `db_path` (which initializes it via migrate()). Returns
    False if the TS toolchain is missing (test is skipped)."""
    if not (TS_DIR / "node_modules").exists():
        return False
    if shutil.which("npx") is None:
        return False
    proc = subprocess.run(
        ["npx", "tsx", "scripts/dump-schema.ts", str(db_path)],
        capture_output=True,
        text=True,
        cwd=str(TS_DIR),
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"TS dump-schema failed: rc={proc.returncode}\n"
            f"stderr:\n{proc.stderr}\n"
            f"stdout:\n{proc.stdout}"
        )
    return True


def main() -> int:
    sys.path.insert(0, str(ROOT / "scripts"))
    from canonicalize_schema import canonical_schema

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        py_db = tmp_path / "py.sqlite"
        ts_db = tmp_path / "ts.sqlite"

        # Create both databases.
        _make_python_db(py_db)
        if not _make_ts_db(ts_db):
            print("SKIP: TS toolchain not installed "
                  "(run `cd servers/typescript && npm install`)")
            print("OK: test_ts_py_schema_parity (skipped)")
            return 0

        # Canonicalize each side.
        with sqlite3.connect(str(py_db)) as conn:
            py_canon = canonical_schema(conn)
        with sqlite3.connect(str(ts_db)) as conn:
            ts_canon = canonical_schema(conn)

        if py_canon != ts_canon:
            print("FAIL: TS↔Py schema diverged after canonicalization", file=sys.stderr)
            py_lines = py_canon.splitlines()
            ts_lines = ts_canon.splitlines()
            for i, (a, b) in enumerate(zip(py_lines, ts_lines)):
                if a != b:
                    print(f"  first diff at line {i + 1}:", file=sys.stderr)
                    print(f"    python: {a!r}", file=sys.stderr)
                    print(f"    ts    : {b!r}", file=sys.stderr)
                    break
            if len(py_lines) != len(ts_lines):
                print(f"  line count differs: py={len(py_lines)} ts={len(ts_lines)}",
                      file=sys.stderr)
            print("---- python canonical schema ----", file=sys.stderr)
            print(py_canon, file=sys.stderr)
            print("---- ts canonical schema ----", file=sys.stderr)
            print(ts_canon, file=sys.stderr)
            return 1

    print(f"OK: TS↔Py canonical schemas byte-equal ({len(py_canon)} chars)")
    print("OK: test_ts_py_schema_parity")
    return 0


if __name__ == "__main__":
    sys.exit(main())
