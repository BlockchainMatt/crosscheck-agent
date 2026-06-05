// Determinism interfaces. Every nondeterministic primitive that the
// Python server reaches for (time, uuid, random) gets injected through
// these abstractions so tests can supply a deterministic implementation.
//
// Why this matters: Phase 0.5 is the harness that proves Py↔Py
// byte-equality on a fixture. Once we trust the canonicalizer, every
// later phase can use a TS↔Py byte-diff as the parity gate.

/** Wall, monotonic, and process clocks. ISO formatter is here so a
 *  fixed clock can supply deterministic timestamps too. */
export interface Clock {
  /** Unix ms since epoch — replaces Python's `time.time() * 1000`. */
  now(): number;
  /** Monotonic ms — replaces `time.monotonic() * 1000`. */
  monotonic(): number;
  /** Process CPU ms — replaces `time.process_time() * 1000`. */
  process(): number;
  /** Format `ts` (default: now()) as RFC-3339 UTC. Mirrors Python's
   *  `datetime.utcnow().strftime(...)` shape but injectable. */
  iso(ts?: number): string;
}

/** UUID + session/call ID generation. */
export interface IdGen {
  /** RFC-4122 v4 UUID. */
  uuid(): string;
  /** Short session identifier (e.g. `s-7af3`). The Python server uses
   *  a 4-hex suffix; we match that shape for cross-language sameness. */
  sessionId(prefix?: string): string;
  /** Unique per-tool-call identifier for ledger correlation. */
  callId(): string;
}

/** Bounded RNG. `next()` is the only required primitive; helpers are
 *  derived from it so tests need only stub `next()`. */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive both ends. */
  int(min: number, max: number): number;
  /** Pick one element uniformly at random. Returns `undefined` for
   *  empty arrays — the caller must handle that. */
  pick<T>(items: readonly T[]): T | undefined;
}

/** Bundle of all the nondeterministic primitives the server uses.
 *  Pass this through the call stack from the entrypoint; tools never
 *  reach for `Date.now()` / `crypto.randomUUID()` / `Math.random()`
 *  directly. */
export interface Determinism {
  readonly clock: Clock;
  readonly idGen: IdGen;
  readonly rng: Rng;
}
