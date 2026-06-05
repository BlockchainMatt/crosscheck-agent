// Unit tests for the determinism primitives. Each implementation has a
// real and a seeded version; the seeded version is the one that must
// produce the SAME output for the SAME seed across runs.

import { describe, expect, it } from "vitest";

import {
  realDeterminism,
  seededDeterminism,
} from "../../src/core/determinism.js";
import { fixedClock, realClock } from "../../src/core/clock.js";
import { seededIdGen } from "../../src/core/idgen.js";
import { seededRng } from "../../src/core/rng.js";

describe("realClock", () => {
  const c = realClock();
  it("returns a sensible wall clock", () => {
    const t = c.now();
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
  it("monotonic is non-decreasing", () => {
    const a = c.monotonic();
    const b = c.monotonic();
    expect(b).toBeGreaterThanOrEqual(a);
  });
  it("iso() round-trips", () => {
    const s = c.iso(1_780_000_000_000);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(s).getTime()).toBe(1_780_000_000_000);
  });
});

describe("fixedClock", () => {
  it("advances by `step` on every call", () => {
    const c = fixedClock({ startMs: 1_000, step: 1 });
    expect(c.now()).toBe(1_000);
    expect(c.now()).toBe(1_001);
    expect(c.monotonic()).toBe(1_002);
  });
  it("process() uses its own counter", () => {
    const c = fixedClock({ startMs: 1_000, cpuStep: 2 });
    expect(c.process()).toBe(0);
    expect(c.process()).toBe(2);
    expect(c.process()).toBe(4);
  });
});

describe("seededRng", () => {
  it("same seed → same sequence", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    for (let i = 0; i < 50; i++) {
      expect(a.next()).toBe(b.next());
    }
  });
  it("different seeds → different sequences", () => {
    const a = seededRng(1);
    const b = seededRng(2);
    expect(a.next()).not.toBe(b.next());
  });
  it("int() honours bounds", () => {
    const r = seededRng(7);
    for (let i = 0; i < 100; i++) {
      const v = r.int(0, 9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
  it("pick() returns undefined on empty array", () => {
    const r = seededRng(7);
    expect(r.pick([])).toBeUndefined();
  });
});

describe("seededIdGen", () => {
  it("same seed + same call order → same ids", () => {
    const a = seededIdGen(42);
    const b = seededIdGen(42);
    expect(a.uuid()).toBe(b.uuid());
    expect(a.uuid()).toBe(b.uuid());
    expect(a.sessionId()).toBe(b.sessionId());
    expect(a.callId()).toBe(b.callId());
  });
  it("ids advance counter-style", () => {
    const g = seededIdGen(42);
    const u1 = g.uuid();
    const u2 = g.uuid();
    expect(u1).not.toBe(u2);
    expect(u1).toMatch(/00000000-0000-4000-8000-/);
    expect(g.sessionId()).toMatch(/^s-/);
  });
});

describe("seededDeterminism", () => {
  it("bundles all three; same seed yields identical traces", () => {
    const a = seededDeterminism(123);
    const b = seededDeterminism(123);
    expect(a.clock.now()).toBe(b.clock.now());
    expect(a.idGen.uuid()).toBe(b.idGen.uuid());
    expect(a.rng.next()).toBe(b.rng.next());
  });
});

describe("realDeterminism", () => {
  it("returns a usable bundle", () => {
    const d = realDeterminism();
    expect(d.clock.now()).toBeGreaterThan(1_700_000_000_000);
    expect(d.idGen.uuid()).toMatch(/-/);
    const r = d.rng.next();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});
