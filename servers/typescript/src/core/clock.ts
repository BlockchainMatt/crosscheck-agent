// Clock implementations.
//
// `realClock()` — production. Uses Date.now(), process.hrtime.bigint(),
// process.cpuUsage(). Wall and CPU times match the Python server's
// `time.time() * 1000` and `time.process_time() * 1000` shapes.
//
// `fixedClock(startMs?)` — test/parity. Each call ADVANCES the internal
// counter by 1 ms (configurable via `step`). Deterministic and ordered
// without needing fakers or vi.useFakeTimers().

import type { Clock } from "./types.js";

/** Production clock — three independent monotonic / wall / CPU sources. */
export function realClock(): Clock {
  const procStart = process.cpuUsage();
  const hrStart = process.hrtime.bigint();
  return {
    now: () => Date.now(),
    monotonic: () => Number((process.hrtime.bigint() - hrStart) / 1_000_000n),
    process: () => {
      const u = process.cpuUsage(procStart);
      return Math.floor((u.user + u.system) / 1000);
    },
    iso: (ts?: number) => new Date(ts ?? Date.now()).toISOString(),
  };
}

/** Deterministic clock — each call advances by `step` ms. Wall and
 *  monotonic share the same counter; process() advances by `cpuStep`
 *  (smaller, since CPU < wall in practice). */
export function fixedClock(opts?: {
  startMs?: number;
  step?: number;
  cpuStep?: number;
}): Clock {
  let wall = opts?.startMs ?? 1_700_000_000_000;
  let cpu = 0;
  const step = opts?.step ?? 1;
  const cpuStep = opts?.cpuStep ?? 1;
  return {
    now: () => {
      const v = wall;
      wall += step;
      return v;
    },
    monotonic: () => {
      const v = wall;
      wall += step;
      return v;
    },
    process: () => {
      const v = cpu;
      cpu += cpuStep;
      return v;
    },
    iso: (ts?: number) =>
      new Date(ts ?? (() => {
        const v = wall;
        wall += step;
        return v;
      })()).toISOString(),
  };
}
