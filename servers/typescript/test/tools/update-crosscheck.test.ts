// Native behavior tests for runUpdateCrosscheck.
//
// All tests inject opts.gitRun + opts.httpFetch so no real git
// commands or HTTP calls happen.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runUpdateCrosscheck,
  type GitRunResult,
} from "../../src/tools/update-crosscheck.js";

let tmpDir: string;

const LOCAL_SHA  = "1111111111111111111111111111111111111111";
const REMOTE_SHA = "2222222222222222222222222222222222222222";
const NOW = 1_700_000_000;

function ok(stdout = ""): GitRunResult { return { code: 0, stdout, stderr: "" }; }
function fail(code = 1, stderr = ""): GitRunResult { return { code, stdout: "", stderr }; }

function mockHttpOk(sha: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ sha }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
}
function mockHttpFail(): typeof fetch {
  return (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
}

beforeEach(() => { tmpDir = mkdtempSync(path.join(tmpdir(), "upd-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("runUpdateCrosscheck — pre-flight failures", () => {
  it("local SHA unavailable → status=error", async () => {
    const gitRun = () => fail(1, "not a git repo");
    const r = await runUpdateCrosscheck(
      {}, { repoRoot: tmpDir, gitRun, httpFetch: mockHttpOk(REMOTE_SHA),
            nowEpochSeconds: () => NOW },
    ) as { status: string; reason: string };
    expect(r.status).toBe("error");
    expect(r.reason).toContain("local git SHA");
  });

  it("remote SHA unavailable → status=error + current_sha trimmed", async () => {
    const gitRun = (a: readonly string[]) => {
      if (a[0] === "rev-parse") return ok(LOCAL_SHA);
      return fail();
    };
    const r = await runUpdateCrosscheck(
      {}, { repoRoot: tmpDir, gitRun, httpFetch: mockHttpFail(),
            nowEpochSeconds: () => NOW },
    ) as { status: string; current_sha: string; reason: string };
    expect(r.status).toBe("error");
    expect(r.reason).toContain("api.github.com");
    expect(r.current_sha).toBe(LOCAL_SHA.slice(0, 12));
  });

  it("local SHA with wrong shape → null (treated as unavailable)", async () => {
    const gitRun = (a: readonly string[]) => {
      if (a[0] === "rev-parse") return ok("not-a-real-sha");
      return fail();
    };
    const r = await runUpdateCrosscheck(
      {}, { repoRoot: tmpDir, gitRun, httpFetch: mockHttpOk(REMOTE_SHA),
            nowEpochSeconds: () => NOW },
    ) as { status: string };
    expect(r.status).toBe("error");
  });
});

describe("runUpdateCrosscheck — relationship outcomes", () => {
  function gitWith(local: string, ahead: number, behind: number): (a: readonly string[]) => GitRunResult {
    return (a) => {
      if (a[0] === "rev-parse") return ok(local);
      if (a[0] === "fetch")     return ok();
      if (a[0] === "cat-file")  return ok();
      if (a[0] === "rev-list") {
        const range = a[2]!;
        if (range.startsWith(REMOTE_SHA)) return ok(String(ahead));
        return ok(String(behind));
      }
      return ok();
    };
  }

  it("local == remote → status=up_to_date + cache written", async () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const r = await runUpdateCrosscheck(
      {}, {
        repoRoot: tmpDir, cachePath,
        gitRun: () => ok(REMOTE_SHA),
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; current_sha: string; latest_sha: string;
            relationship: string; update_available: boolean };
    expect(r.status).toBe("up_to_date");
    expect(r.relationship).toBe("equal");
    expect(r.update_available).toBe(false);
    expect(r.current_sha).toBe(REMOTE_SHA.slice(0, 12));
    expect(r.latest_sha).toBe(REMOTE_SHA.slice(0, 12));
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.checked_at).toBe(NOW);
    expect(cache.relationship).toBe("equal");
  });

  it("local ahead → status=local_ahead with push hint", async () => {
    const r = await runUpdateCrosscheck(
      {}, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: gitWith(LOCAL_SHA, 3, 0),
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; ahead: number; next_step: string };
    expect(r.status).toBe("local_ahead");
    expect(r.ahead).toBe(3);
    expect(r.next_step).toContain("3 commit(s) ahead");
    expect(r.next_step).toContain("git push origin main");
  });

  it("diverged → status=diverged + manual-resolve hint", async () => {
    const r = await runUpdateCrosscheck(
      {}, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: gitWith(LOCAL_SHA, 2, 5),
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; ahead: number; behind: number; next_step: string };
    expect(r.status).toBe("diverged");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(5);
    expect(r.next_step).toContain("diverged");
  });

  it("cat-file fails → status=error + ancestry-unknown reason", async () => {
    const r = await runUpdateCrosscheck(
      {}, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: (a) => {
          if (a[0] === "rev-parse") return ok(LOCAL_SHA);
          if (a[0] === "fetch")     return ok();
          if (a[0] === "cat-file")  return fail(1, "no such object");
          return ok();
        },
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; relationship: string; reason: string };
    expect(r.status).toBe("error");
    expect(r.relationship).toBe("unknown");
    expect(r.reason).toContain("ancestry");
  });
});

describe("runUpdateCrosscheck — behind (no apply)", () => {
  it("emits status=update_available + notice in cache", async () => {
    const cachePath = path.join(tmpDir, "c.json");
    const r = await runUpdateCrosscheck(
      { apply: false }, {
        repoRoot: tmpDir, cachePath,
        gitRun: (a) => {
          if (a[0] === "rev-parse") return ok(LOCAL_SHA);
          if (a[0] === "fetch")     return ok();
          if (a[0] === "cat-file")  return ok();
          if (a[0] === "rev-list") {
            const range = a[2]!;
            return ok(range.startsWith(REMOTE_SHA) ? "0" : "7");
          }
          return ok();
        },
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; behind: number; next_step: string };
    expect(r.status).toBe("update_available");
    expect(r.behind).toBe(7);
    expect(r.next_step).toContain("7 commit(s) behind");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.update_available).toBe(true);
    expect(cache.notice).toBeDefined();
    expect(cache.notice.ask_user).toBe(true);
  });
});

describe("runUpdateCrosscheck — behind (apply=true)", () => {
  const NEW_LOCAL = REMOTE_SHA;

  function gitWithSuccessfulPull(initialLocal: string): (a: readonly string[]) => GitRunResult {
    let pulled = false;
    return (a) => {
      if (a[0] === "rev-parse") return ok(pulled ? NEW_LOCAL : initialLocal);
      if (a[0] === "fetch")     return ok();
      if (a[0] === "cat-file")  return ok();
      if (a[0] === "rev-list") {
        const range = a[2]!;
        return ok(range.startsWith(REMOTE_SHA) ? "0" : "3");
      }
      if (a[0] === "pull") { pulled = true; return ok("Fast-forward\n"); }
      return ok();
    };
  }

  it("status=updated + new_sha + restart_required when pull succeeds", async () => {
    const r = await runUpdateCrosscheck(
      { apply: true }, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: gitWithSuccessfulPull(LOCAL_SHA),
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; new_sha: string; restart_required: boolean;
            restart_instructions: string };
    expect(r.status).toBe("updated");
    expect(r.new_sha).toBe(NEW_LOCAL.slice(0, 12));
    expect(r.restart_required).toBe(true);
    expect(r.restart_instructions).toContain("MCP server cannot reload");
  });

  it("status=pull_failed when git pull exits non-zero", async () => {
    const r = await runUpdateCrosscheck(
      { apply: true }, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: (a) => {
          if (a[0] === "rev-parse") return ok(LOCAL_SHA);
          if (a[0] === "fetch")     return ok();
          if (a[0] === "cat-file")  return ok();
          if (a[0] === "rev-list") {
            const range = a[2]!;
            return ok(range.startsWith(REMOTE_SHA) ? "0" : "1");
          }
          if (a[0] === "pull") return fail(1, "Cannot fast-forward");
          return ok();
        },
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; exit_code: number; stderr: string; next_step: string };
    expect(r.status).toBe("pull_failed");
    expect(r.exit_code).toBe(1);
    expect(r.stderr).toContain("Cannot fast-forward");
    expect(r.next_step).toContain("uncommitted local changes");
  });

  it("status=pull_failed when git command throws", async () => {
    const r = await runUpdateCrosscheck(
      { apply: true }, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: (a) => {
          if (a[0] === "rev-parse") return ok(LOCAL_SHA);
          if (a[0] === "fetch")     return ok();
          if (a[0] === "cat-file")  return ok();
          if (a[0] === "rev-list") {
            const range = a[2]!;
            return ok(range.startsWith(REMOTE_SHA) ? "0" : "1");
          }
          if (a[0] === "pull") return { code: -1, stdout: "", stderr: "spawn ENOENT" };
          return ok();
        },
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as { status: string; error: string };
    expect(r.status).toBe("pull_failed");
    expect(r.error).toContain("ENOENT");
  });
});

describe("runUpdateCrosscheck — output shape sanity", () => {
  it("emits {tool, current_sha, latest_sha, relationship, ahead, behind, ...}", async () => {
    const r = await runUpdateCrosscheck(
      {}, {
        repoRoot: tmpDir, cachePath: path.join(tmpDir, "c.json"),
        gitRun: () => ok(REMOTE_SHA),
        httpFetch: mockHttpOk(REMOTE_SHA),
        nowEpochSeconds: () => NOW,
      },
    ) as Record<string, unknown>;
    expect(r["tool"]).toBe("update_crosscheck");
    expect(typeof r["current_sha"]).toBe("string");
    expect(typeof r["latest_sha"]).toBe("string");
    expect(r["relationship"]).toBe("equal");
    expect(r["remote_url"]).toBe("https://github.com/fxspeiser/crosscheck-agent");
  });
});
