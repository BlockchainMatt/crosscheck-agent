// Output canonicalizer.
//
// Two responses are "equivalent" if their canonical forms are byte-equal.
// Used by the Phase-0.5 Py↔Py parity harness and, in later phases, by
// the TS↔Py byte-diff CI gate.
//
// Normalizations applied:
//   - Strip transient keys (latencies, timestamps, transcript paths).
//   - Replace ISO-8601 timestamps with the fixed token `<TS>`.
//   - Replace UUIDs with positional tokens `<UUID:N>` in first-seen order.
//   - Replace canary nonces (`CC_CANARY_<HEX>`) with `<CANARY:N>`.
//   - Replace session ids matching `s-XXXX` with `<SID:N>`.
//   - Round numbers to 6 decimal places (string `.toFixed(6)` semantics).
//   - Sort object keys recursively (Unicode lexicographic).
//
// All of this must match the Python mirror in `scripts/canonicalize.py`
// EXACTLY. Each change here needs a matching change there.

const TRANSIENT_KEYS = new Set<string>([
  // Timing — never deterministic.
  "wall_ms",
  "cpu_ms",
  "elapsed_ms",
  "wall_used_ms",
  "wall_remaining_ms",
  "cpu_used_ms",
  // Timestamps embedded in run_summary / sessions / pin files.
  "started_at",
  "ended_at",
  "pinned_at",
  "last_at",
  "created_at",
  "stale_at",
  "ts",
  // Transcript paths embed millisecond filenames.
  "transcript_path",
  "transcript",
  // Cache-hit counters — true cross-run but accumulate; tests rarely care.
  "cache_hits",
  // Per-call HTTP attempts vary with transient network.
  "attempts",
]);

const ISO_TS_RE   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANARY_RE   = /^CC_CANARY_[0-9A-F]+$/;
const SID_RE      = /^s-[0-9a-f]{4,}$/;

const ISO_INLINE_RE    = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const UUID_INLINE_RE   = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CANARY_INLINE_RE = /CC_CANARY_[0-9A-F]+/g;
const SID_INLINE_RE    = /\bs-[0-9a-f]{4,}\b/g;

export interface CanonicalizeOptions {
  /** Number of decimal places to round floats to before serializing.
   *  Default 6 — matches Python's mirror. */
  floatPrecision?: number;
  /** Override transient-key set. Useful when a specific test wants
   *  timing assertions and explicitly opts back in. */
  transientKeys?: ReadonlySet<string>;
}

/** Canonicalize a JS value and return a stable JSON string. The string
 *  is suitable for direct byte-comparison. */
export function canonicalize(value: unknown, opts?: CanonicalizeOptions): string {
  const ctx: Ctx = {
    floatPrecision: opts?.floatPrecision ?? 6,
    transient: opts?.transientKeys ?? TRANSIENT_KEYS,
    uuids: new Map(),
    canaries: new Map(),
    sids: new Map(),
  };
  return jsonify(normalize(value, ctx));
}

interface Ctx {
  floatPrecision: number;
  transient: ReadonlySet<string>;
  uuids: Map<string, string>;
  canaries: Map<string, string>;
  sids: Map<string, string>;
}

function normalize(v: unknown, ctx: Ctx): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => normalize(x, ctx));
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return v;
    // Use toFixed(N) so 1.1+2.2 doesn't render as 3.3000000000000003.
    return Number(v.toFixed(ctx.floatPrecision));
  }
  if (typeof v === "string") return normalizeString(v, ctx);
  if (typeof v === "boolean") return v;
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, val] of entries) {
      if (ctx.transient.has(k)) continue;
      out[k] = normalize(val, ctx);
    }
    return out;
  }
  // Functions / symbols / bigint shouldn't appear in MCP outputs; if they
  // do, stringify defensively.
  return String(v);
}

function normalizeString(s: string, ctx: Ctx): string {
  // Exact-match token replacements first (faster + clearer).
  if (ISO_TS_RE.test(s))   return "<TS>";
  if (UUID_RE.test(s))     return tokenFor(ctx.uuids, s, "UUID");
  if (CANARY_RE.test(s))   return tokenFor(ctx.canaries, s, "CANARY");
  if (SID_RE.test(s))      return tokenFor(ctx.sids, s, "SID");
  // Inline replacements — strings that EMBED a UUID / TS / canary.
  let out = s;
  out = out.replace(ISO_INLINE_RE, "<TS>");
  out = out.replace(UUID_INLINE_RE, (m) => tokenFor(ctx.uuids, m, "UUID"));
  out = out.replace(CANARY_INLINE_RE, (m) => tokenFor(ctx.canaries, m, "CANARY"));
  out = out.replace(SID_INLINE_RE, (m) => tokenFor(ctx.sids, m, "SID"));
  return out;
}

function tokenFor(map: Map<string, string>, key: string, prefix: string): string {
  const existing = map.get(key);
  if (existing) return existing;
  const tok = `<${prefix}:${map.size + 1}>`;
  map.set(key, tok);
  return tok;
}

/** JSON-serialize with sorted keys. The replacer is run AFTER normalize()
 *  has already pruned transient keys, so the only job here is key order. */
function jsonify(v: unknown): string {
  return JSON.stringify(v, sortReplacer, 0);
}

function sortReplacer(_k: string, val: unknown): unknown {
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return val;
}
