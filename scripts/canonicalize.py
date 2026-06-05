#!/usr/bin/env python3
"""Output canonicalizer — Python mirror.

MUST stay byte-identical with `servers/typescript/src/core/canonicalize.ts`.
Every normalization decision (transient-key set, ISO/UUID/canary/SID
patterns, float precision, key-sort order) is intentionally duplicated
so the two halves of the Py↔Py / TS↔Py parity gate produce the SAME
canonical bytes given the SAME logical state.

When you change one, change the other in lockstep.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Mapping

# These match TRANSIENT_KEYS in the TS canonicalizer exactly.
_TRANSIENT_KEYS: frozenset[str] = frozenset({
    # Timing
    "wall_ms", "cpu_ms", "elapsed_ms",
    "wall_used_ms", "wall_remaining_ms", "cpu_used_ms",
    # Timestamps
    "started_at", "ended_at", "pinned_at", "last_at", "created_at",
    "stale_at", "ts",
    # Transcript paths
    "transcript_path", "transcript",
    # Cache-hit counters
    "cache_hits",
    # HTTP retry counts
    "attempts",
})

_ISO_TS_RE    = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$")
_UUID_RE      = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_CANARY_RE    = re.compile(r"^CC_CANARY_[0-9A-F]+$")
_SID_RE       = re.compile(r"^s-[0-9a-f]{4,}$")

_ISO_INLINE_RE    = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?")
_UUID_INLINE_RE   = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_CANARY_INLINE_RE = re.compile(r"CC_CANARY_[0-9A-F]+")
_SID_INLINE_RE    = re.compile(r"\bs-[0-9a-f]{4,}\b")


def canonicalize(value: Any, *, float_precision: int = 6,
                  transient: frozenset[str] | None = None) -> str:
    """Canonicalize a JSON-like value to a stable string suitable for byte
    comparison against TypeScript's canonicalize() output."""
    ctx = _Ctx(
        float_precision=float_precision,
        transient=transient if transient is not None else _TRANSIENT_KEYS,
        uuids={},
        canaries={},
        sids={},
    )
    normalized = _normalize(value, ctx)
    # sort_keys + separators=(",", ":") matches JSON.stringify(v, replacer, 0)
    # with our sortReplacer. ensure_ascii=False so embedded unicode survives.
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False)


class _Ctx:
    __slots__ = ("float_precision", "transient", "uuids", "canaries", "sids")

    def __init__(self, float_precision: int, transient: frozenset[str],
                  uuids: dict[str, str], canaries: dict[str, str],
                  sids: dict[str, str]):
        self.float_precision = float_precision
        self.transient       = transient
        self.uuids           = uuids
        self.canaries        = canaries
        self.sids            = sids


def _normalize(v: Any, ctx: _Ctx) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):           # must check BEFORE int (bool is int)
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        # Match JS Number.isFinite() / toFixed(N) semantics. NaN / Inf -> null.
        if v != v or v in (float("inf"), float("-inf")):
            return None
        if v.is_integer():
            return int(v)
        # Round to N decimal places, then re-parse so trailing zeros are
        # dropped (matching JS `Number(x.toFixed(6))`).
        return float(f"{v:.{ctx.float_precision}f}")
    if isinstance(v, str):
        return _normalize_str(v, ctx)
    if isinstance(v, list) or isinstance(v, tuple):
        return [_normalize(x, ctx) for x in v]
    if isinstance(v, Mapping):
        out: dict[str, Any] = {}
        for k, val in v.items():
            if k in ctx.transient:
                continue
            out[str(k)] = _normalize(val, ctx)
        return out
    # bytes / set / etc. — stringify defensively, matching TS String(v).
    return str(v)


def _normalize_str(s: str, ctx: _Ctx) -> str:
    if _ISO_TS_RE.match(s):
        return "<TS>"
    if _UUID_RE.match(s):
        return _token_for(ctx.uuids, s, "UUID")
    if _CANARY_RE.match(s):
        return _token_for(ctx.canaries, s, "CANARY")
    if _SID_RE.match(s):
        return _token_for(ctx.sids, s, "SID")
    out = s
    out = _ISO_INLINE_RE.sub("<TS>", out)
    out = _UUID_INLINE_RE.sub(lambda m: _token_for(ctx.uuids, m.group(0), "UUID"), out)
    out = _CANARY_INLINE_RE.sub(lambda m: _token_for(ctx.canaries, m.group(0), "CANARY"), out)
    out = _SID_INLINE_RE.sub(lambda m: _token_for(ctx.sids, m.group(0), "SID"), out)
    return out


def _token_for(table: dict[str, str], key: str, prefix: str) -> str:
    existing = table.get(key)
    if existing is not None:
        return existing
    tok = f"<{prefix}:{len(table) + 1}>"
    table[key] = tok
    return tok


# ----------------------------------------------------------------------
# CLI: `canonicalize.py <file.jsonl>` prints each line's canonical form.
# Useful for debugging diff failures.
# ----------------------------------------------------------------------
def _cli(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: canonicalize.py <file.jsonl>\n")
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                print("")
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError:
                # Mirror TS safeParse: compare raw text on parse failure.
                doc = line
            print(canonicalize(doc))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv))
