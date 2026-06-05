// Id generation. Real uses crypto.randomUUID(); seeded uses a counter
// suffixed onto a stable prefix so two test runs with the same seed
// produce identical ids in identical order.

import { randomUUID } from "node:crypto";

import type { IdGen, Rng } from "./types.js";

/** Production: cryptographic UUIDs + 4-hex session ids (matching the
 *  Python server's `s-XXXX` shape). */
export function realIdGen(rng?: Rng): IdGen {
  // Session/call ids use the rng (if supplied) so a seeded rng yields
  // reproducible ids; otherwise use Math.random() via the default.
  const rnd = rng ?? defaultRng();
  return {
    uuid: () => randomUUID(),
    sessionId: (prefix = "s-") => {
      // 4-hex suffix; matches Python `format(int(random()*0x10000),"04x")`.
      const n = Math.floor(rnd.next() * 0x10000);
      return prefix + n.toString(16).padStart(4, "0");
    },
    callId: () => randomUUID(),
  };
}

/** Seeded: deterministic id generator. Counter-based, so order matters.
 *  Use only when you control the call order (i.e. tests). */
export function seededIdGen(seed: number): IdGen {
  let uuidCounter = 0;
  let callCounter = 0;
  let sessionCounter = 0;
  const seedHex = ((seed >>> 0) || 1).toString(16).padStart(8, "0");
  return {
    uuid: () => `00000000-0000-4000-8000-${seedHex}${(uuidCounter++)
      .toString(16)
      .padStart(4, "0")}`,
    sessionId: (prefix = "s-") =>
      prefix + (sessionCounter++).toString(16).padStart(4, "0"),
    callId: () =>
      `c-${seedHex}-${(callCounter++).toString(16).padStart(4, "0")}`,
  };
}

function defaultRng(): Rng {
  return {
    next: () => Math.random(),
    int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]) =>
      items.length === 0 ? undefined : items[Math.floor(Math.random() * items.length)],
  };
}
