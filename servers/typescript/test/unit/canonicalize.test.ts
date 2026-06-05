// Canonicalizer tests. These pin down the EXACT normalization the Py↔Py
// and TS↔Py parity gates rely on. If you change behavior here, change
// the Python mirror in `scripts/canonicalize.py` in lockstep.

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";

describe("canonicalize: key order", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });
  it("sorts nested keys recursively", () => {
    const r = canonicalize({ outer: { z: 1, a: 2 }, alpha: { y: 1, x: 2 } });
    expect(r).toBe('{"alpha":{"x":2,"y":1},"outer":{"a":2,"z":1}}');
  });
});

describe("canonicalize: transient-key stripping", () => {
  it("strips timing + transcript fields", () => {
    const r = canonicalize({
      ok: true,
      wall_ms: 137,
      cpu_ms: 9,
      elapsed_ms: 12,
      transcript_path: "/tmp/x.json",
      transcript: "/tmp/x.json",
      ended_at: 1_780_000_000,
      started_at: 1_780_000_000,
    });
    expect(r).toBe('{"ok":true}');
  });
  it("strips transient keys recursively", () => {
    const r = canonicalize({
      data: { keep: 1, wall_ms: 99 },
      arr: [{ keep: 2, cache_hits: 5 }],
    });
    expect(r).toBe('{"arr":[{"keep":2}],"data":{"keep":1}}');
  });
});

describe("canonicalize: ISO timestamps", () => {
  it("normalizes ISO-8601 strings to <TS>", () => {
    expect(canonicalize("2026-05-25T19:43:54Z")).toBe('"<TS>"');
    expect(canonicalize("2026-05-25T19:43:54.123Z")).toBe('"<TS>"');
  });
  it("normalizes inline timestamps inside text", () => {
    const r = canonicalize({
      msg: "completed at 2026-05-25T19:43:54Z after retry",
    });
    expect(r).toBe('{"msg":"completed at <TS> after retry"}');
  });
});

describe("canonicalize: UUID + canary + session-id tokens", () => {
  it("UUIDs map to positional tokens in first-seen order", () => {
    const r = canonicalize({
      a: "abcdef01-2345-4678-9abc-def012345678",
      b: "11111111-2222-4333-9444-555555555555",
      c: "abcdef01-2345-4678-9abc-def012345678", // re-use
    });
    // Sorted keys: a, b, c. a is first-seen UUID:1; b is UUID:2; c is the
    // same string as a, gets UUID:1.
    expect(r).toBe('{"a":"<UUID:1>","b":"<UUID:2>","c":"<UUID:1>"}');
  });
  it("canary nonces map to positional tokens", () => {
    const r = canonicalize({
      x: "CC_CANARY_DEADBEEFCAFE",
      y: "CC_CANARY_FACEFEED",
    });
    expect(r).toBe('{"x":"<CANARY:1>","y":"<CANARY:2>"}');
  });
  it("session ids map to positional tokens", () => {
    const r = canonicalize({ a: "s-7af3", b: "s-7af3", c: "s-0001" });
    expect(r).toBe('{"a":"<SID:1>","b":"<SID:1>","c":"<SID:2>"}');
  });
  it("inline UUIDs/canaries inside text are tokenized too", () => {
    const r = canonicalize({
      log: "leak: CC_CANARY_ABC123 in id abcdef01-2345-4678-9abc-def012345678",
    });
    expect(r).toBe(
      '{"log":"leak: <CANARY:1> in id <UUID:1>"}',
    );
  });
});

describe("canonicalize: float rounding", () => {
  it("rounds floats to 6 dp by default", () => {
    expect(canonicalize(1 / 3)).toBe("0.333333");
    expect(canonicalize(0.1 + 0.2)).toBe("0.3");
  });
  it("integers stay integers", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(0)).toBe("0");
  });
  it("custom precision is honoured", () => {
    expect(canonicalize(1 / 3, { floatPrecision: 2 })).toBe("0.33");
  });
  it("NaN/Infinity become null", () => {
    expect(canonicalize(NaN)).toBe("null");
    expect(canonicalize(Infinity)).toBe("null");
  });
});

describe("canonicalize: order independence", () => {
  it("two responses with reshuffled top-level keys canonicalize identically", () => {
    const a = {
      tool: "ping",
      version: "0.1.0",
      pong: "hello",
      wall_ms: 12,
      ended_at: "2026-05-25T19:43:54Z",
    };
    const b = {
      pong: "hello",
      version: "0.1.0",
      tool: "ping",
      ended_at: "2026-05-25T19:43:54Z",
      wall_ms: 99,
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});
