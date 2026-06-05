// Native behavior tests for runFetch.
//
// No live HTTP — every test injects a mock fetchImpl. Evidence
// directory is a tmp directory per test.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { openBetterSqliteStorage } from "../../src/adapters/storage/better-sqlite3.js";
import { runFetch, __test_internals } from "../../src/tools/fetch.js";

import type { Storage } from "../../src/adapters/storage/interface.js";

let storage: Storage;
let tmpDir: string;

const NOW = 1_700_000_000;
const nowEpochSeconds = () => NOW;

function mockFetch(
  status: number,
  body: string | Uint8Array,
  contentType = "text/plain",
): typeof fetch {
  return (async (_url: string, _init?: unknown): Promise<Response> => {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body;
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(ab, {
      status,
      headers: { "Content-Type": contentType },
    });
  }) as typeof fetch;
}

function mockFetchThrows(err: Error): typeof fetch {
  return (async () => { throw err; }) as typeof fetch;
}

beforeEach(async () => {
  storage = openBetterSqliteStorage({ path: ":memory:", wal: false });
  await storage.migrate();
  tmpDir = mkdtempSync(path.join(tmpdir(), "fetch-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runFetch — config gates", () => {
  it("enabled=false → accepted=false", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      { config: { enabled: false } },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("fetch is disabled");
  });

  it("non-http/https scheme rejected", async () => {
    const r = await runFetch(
      { url: "file:///etc/passwd" }, { config: { url_allowlist: ["file://"] } },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("http/https");
  });

  it("empty allowlist → reject regardless of URL", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" }, { config: {} },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("url_allowlist is empty");
  });

  it("URL not in allowlist → reject + echo allowlist", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      { config: { url_allowlist: ["https://other.example/"] } },
    ) as { accepted: boolean; reason: string; allowlist: string[] };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("not covered");
    expect(r.allowlist).toEqual(["https://other.example/"]);
  });

  it("URL prefix-matched in allowlist → proceeds", async () => {
    const r = await runFetch(
      { url: "https://example.com/path?q=1" },
      {
        config:    { url_allowlist: ["https://example.com/"], evidence_dir: tmpDir },
        repoRoot:  tmpDir,
        fetchImpl: mockFetch(200, "hello world"),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; bytes: number };
    expect(r.accepted).toBe(true);
    expect(r.bytes).toBe(11);
  });
});

describe("runFetch — caching", () => {
  it("first fetch writes evidence files + meta", async () => {
    const r = await runFetch(
      { url: "https://example.com/p" },
      {
        config:    { url_allowlist: ["https://example.com/"], evidence_dir: tmpDir },
        repoRoot:  tmpDir,
        fetchImpl: mockFetch(200, "body bytes here"),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; cached: boolean; sha256: string; bytes: number; path: string; content_type: string; status: number };
    expect(r.accepted).toBe(true);
    expect(r.cached).toBe(false);
    expect(r.bytes).toBe(15);
    expect(r.content_type).toBe("text/plain");
    expect(r.status).toBe(200);
    // body file written + content matches
    const bodyAbs = path.join(tmpDir, `${r.sha256}.bin`);
    expect(existsSync(bodyAbs)).toBe(true);
    expect(readFileSync(bodyAbs, "utf8")).toBe("body bytes here");
    // meta file written
    const urlHash16 = createHash("sha256").update("https://example.com/p", "utf8").digest("hex").slice(0, 16);
    const metaAbs = path.join(tmpDir, `by-url-${urlHash16}.json`);
    expect(existsSync(metaAbs)).toBe(true);
    const meta = JSON.parse(readFileSync(metaAbs, "utf8"));
    expect(meta.url).toBe("https://example.com/p");
    expect(meta.sha256).toBe(r.sha256);
    expect(meta.bytes).toBe(15);
    expect(meta.fetched_at).toBe(NOW);
  });

  it("second fetch returns cached=true without HTTP call", async () => {
    const cfg = {
      url_allowlist: ["https://example.com/"], evidence_dir: tmpDir,
    };
    // First fetch.
    await runFetch(
      { url: "https://example.com/p" },
      { config: cfg, repoRoot: tmpDir, fetchImpl: mockFetch(200, "body"), nowEpochSeconds },
    );
    // Second fetch with a fetchImpl that THROWS — proves no HTTP is made.
    const r = await runFetch(
      { url: "https://example.com/p" },
      {
        config: cfg, repoRoot: tmpDir,
        fetchImpl: mockFetchThrows(new Error("should not be called")),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; cached: boolean; sha256: string };
    expect(r.accepted).toBe(true);
    expect(r.cached).toBe(true);
    expect(r.sha256).toBeDefined();
  });

  it("force_refresh=true bypasses cache", async () => {
    const cfg = {
      url_allowlist: ["https://example.com/"], evidence_dir: tmpDir,
    };
    await runFetch(
      { url: "https://example.com/p" },
      { config: cfg, repoRoot: tmpDir, fetchImpl: mockFetch(200, "v1"), nowEpochSeconds },
    );
    const r = await runFetch(
      { url: "https://example.com/p", force_refresh: true },
      { config: cfg, repoRoot: tmpDir, fetchImpl: mockFetch(200, "v2"), nowEpochSeconds },
    ) as { cached: boolean; bytes: number };
    expect(r.cached).toBe(false);
    expect(r.bytes).toBe(2);
  });
});

describe("runFetch — HTTP error paths", () => {
  it("HTTP 404 → accepted=false with body snippet", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      {
        config: { url_allowlist: ["https://example.com/"], evidence_dir: tmpDir },
        repoRoot: tmpDir,
        fetchImpl: mockFetch(404, "not found"),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("HTTP 404");
    expect(r.reason).toContain("not found");
  });

  it("network error → accepted=false", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      {
        config: { url_allowlist: ["https://example.com/"], evidence_dir: tmpDir },
        repoRoot: tmpDir,
        fetchImpl: mockFetchThrows(new Error("DNS lookup failed")),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("network error");
    expect(r.reason).toContain("DNS lookup failed");
  });

  it("response over max_bytes → accepted=false", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      {
        config: {
          url_allowlist: ["https://example.com/"],
          evidence_dir: tmpDir,
          max_bytes: 4,
        },
        repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "hello world"),
        nowEpochSeconds,
      },
    ) as { accepted: boolean; reason: string };
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("max_bytes=4");
  });
});

describe("runFetch — egress accounting", () => {
  it("records bytes against the session after a successful fetch", async () => {
    await runFetch(
      { url: "https://example.com/x", session_id: "s1" },
      {
        config: { url_allowlist: ["https://example.com/"], evidence_dir: tmpDir },
        storage, repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "abcd"),
        nowEpochSeconds,
      },
    );
    const totals = await storage.getFetchEgressTotals("s1");
    expect(totals.total_bytes).toBe(4);
    expect(totals.unique_hosts).toBe(1);
  });

  it("rejects when session has already exceeded max_bytes_per_session", async () => {
    // Pre-seed 100 bytes pulled for session s1.
    await storage.recordFetchEgress("s1", "example.com", 100, NOW);
    const r = await runFetch(
      { url: "https://example.com/p", session_id: "s1" },
      {
        config: {
          url_allowlist: ["https://example.com/"],
          evidence_dir: tmpDir,
          max_bytes_per_session: 50,
        },
        storage, repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "x"), nowEpochSeconds,
      },
    ) as { accepted: boolean; error_code: string; cap_bytes: number };
    expect(r.accepted).toBe(false);
    expect(r.error_code).toBe("FETCH_EGRESS_BYTES_EXCEEDED");
    expect(r.cap_bytes).toBe(50);
  });

  it("rejects new hosts at max_unique_hosts cap; allows seen hosts", async () => {
    // Pre-seed two hosts → unique_hosts = 2. Cap is 2.
    await storage.recordFetchEgress("s1", "a.example", 1, NOW);
    await storage.recordFetchEgress("s1", "b.example", 1, NOW);
    const cfg = {
      url_allowlist: ["https://a.example", "https://b.example", "https://c.example"],
      evidence_dir: tmpDir, max_unique_hosts_per_session: 2,
    };
    // c.example would be a 3rd unique host → REJECT.
    const reject = await runFetch(
      { url: "https://c.example/x", session_id: "s1" },
      { config: cfg, storage, repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "y"), nowEpochSeconds },
    ) as { accepted: boolean; error_code: string };
    expect(reject.accepted).toBe(false);
    expect(reject.error_code).toBe("FETCH_EGRESS_HOSTS_EXCEEDED");
    // a.example is already-seen → ALLOWED.
    const accept = await runFetch(
      { url: "https://a.example/x", session_id: "s1" },
      { config: cfg, storage, repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "ok"), nowEpochSeconds },
    ) as { accepted: boolean };
    expect(accept.accepted).toBe(true);
  });

  it("no storage → caps silently treated as unlimited (matches Python except-pass)", async () => {
    // Even with caps set, no storage means no egress lookup; fetch
    // proceeds. (Python's _fetch_egress_stats returns (0,0) on
    // exception → caps never triggered.)
    const r = await runFetch(
      { url: "https://example.com/x", session_id: "s1" },
      {
        config: {
          url_allowlist: ["https://example.com/"], evidence_dir: tmpDir,
          max_bytes_per_session: 1, max_unique_hosts_per_session: 1,
        },
        repoRoot: tmpDir, fetchImpl: mockFetch(200, "abc"), nowEpochSeconds,
      },
    ) as { accepted: boolean };
    expect(r.accepted).toBe(true);
  });
});

describe("runFetch — path resolution", () => {
  it("returns relative path when bodyPath is under repoRoot", async () => {
    const r = await runFetch(
      { url: "https://example.com/x" },
      {
        config: { url_allowlist: ["https://example.com/"], evidence_dir: "ev" },
        repoRoot: tmpDir,
        fetchImpl: mockFetch(200, "x"),
        nowEpochSeconds,
      },
    ) as { path: string };
    expect(r.path.startsWith("ev/")).toBe(true);
    expect(r.path.endsWith(".bin")).toBe(true);
  });

  it("returns absolute path when bodyPath is outside repoRoot", async () => {
    const r = await runFetch(
      { url: "https://example.com/y" },
      {
        config: {
          url_allowlist: ["https://example.com/"],
          evidence_dir: tmpDir,
        },
        // no repoRoot → absolute
        fetchImpl: mockFetch(200, "y"),
        nowEpochSeconds,
      },
    ) as { path: string };
    expect(path.isAbsolute(r.path)).toBe(true);
  });
});

describe("runFetch — pure helpers", () => {
  const { isUrlAllowed, extractHost, sha256Hex, makeRelative } = __test_internals;

  it("isUrlAllowed prefix-matches", () => {
    expect(isUrlAllowed("https://a.example/x", ["https://a.example/"])).toBe(true);
    expect(isUrlAllowed("https://a.example/x", ["https://b.example/"])).toBe(false);
  });

  it("extractHost handles weird inputs", () => {
    expect(extractHost("https://Example.com:443/path")).toBe("example.com");
    expect(extractHost("not a url")).toBe("");
  });

  it("sha256Hex deterministic", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("makeRelative drops the repo prefix", () => {
    expect(makeRelative("/repo/foo/bar.bin", "/repo")).toBe("foo/bar.bin");
    expect(makeRelative("/elsewhere/bar.bin", "/repo")).toBe("/elsewhere/bar.bin");
  });
});

describe("runFetch — re-fetch on corrupted meta", () => {
  it("malformed meta JSON triggers a re-fetch", async () => {
    const cfg = {
      url_allowlist: ["https://example.com/"], evidence_dir: tmpDir,
    };
    // Pre-seed a malformed meta file at the cache location.
    const urlHash16 = createHash("sha256").update("https://example.com/p", "utf8").digest("hex").slice(0, 16);
    writeFileSync(path.join(tmpDir, `by-url-${urlHash16}.json`), "not json");
    const r = await runFetch(
      { url: "https://example.com/p" },
      { config: cfg, repoRoot: tmpDir, fetchImpl: mockFetch(200, "fresh"), nowEpochSeconds },
    ) as { accepted: boolean; cached: boolean };
    expect(r.accepted).toBe(true);
    expect(r.cached).toBe(false);  // re-fetched because meta couldn't be parsed
  });
});
