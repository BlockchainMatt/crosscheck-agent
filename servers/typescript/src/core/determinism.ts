// Bundled Determinism factory. Pass `realDeterminism()` from the
// production entrypoint; pass `seededDeterminism(seed)` from tests and
// parity fixtures.

import { fixedClock, realClock } from "./clock.js";
import { realIdGen, seededIdGen } from "./idgen.js";
import { realRng, seededRng } from "./rng.js";
import type { Determinism } from "./types.js";

export function realDeterminism(): Determinism {
  const rng = realRng();
  return {
    clock: realClock(),
    idGen: realIdGen(rng),
    rng,
  };
}

export function seededDeterminism(seed: number, opts?: {
  startMs?: number;
  step?: number;
  cpuStep?: number;
}): Determinism {
  return {
    clock: fixedClock(opts),
    idGen: seededIdGen(seed),
    rng: seededRng(seed),
  };
}
