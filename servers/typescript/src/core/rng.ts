// RNG implementations.
//
// `realRng()` — Math.random() under the hood.
// `seededRng(seed)` — Mulberry32 PRNG. 32-bit period (long enough for tests),
// trivial to mirror in Python so TS↔Py random sequences match given the
// same seed. The Python mirror is in scripts/canonicalize.py.

import type { Rng } from "./types.js";

export function realRng(): Rng {
  return baseRng(() => Math.random());
}

/** Deterministic PRNG. Same seed → same sequence in TS and Python. */
export function seededRng(seed: number): Rng {
  // Mulberry32 — small, fast, decent statistical quality, easy to port.
  let state = (seed >>> 0) || 1;
  return baseRng(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  });
}

function baseRng(next: () => number): Rng {
  return {
    next,
    int(min, max) {
      if (max < min) throw new RangeError("rng.int: max < min");
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      const idx = Math.floor(next() * items.length);
      // noUncheckedIndexedAccess: items[idx] is T | undefined; if items
      // is non-empty and idx is in-range, it's T.
      return items[idx];
    },
  };
}
