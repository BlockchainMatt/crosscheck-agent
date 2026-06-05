// Native TS port of Python's `tool_update_crosscheck` — Phase 5 part 22.
//
// Compares the local git HEAD to the remote GitHub `main` HEAD and
// reports the relationship (equal / ahead / behind / diverged /
// unknown). With `apply=true`, fast-forwards via `git pull --ff-only`
// when the local is strictly behind.
//
// Subsystems used:
//   - child_process.spawnSync for git commands (rev-parse, fetch,
//     cat-file -e, rev-list --count, pull --ff-only)
//   - global fetch (Node 18+) for the GitHub API call
//   - node:fs for the on-disk cache (.crosscheck/update_check.json)
//
// Injection points (for tests):
//   - opts.gitRun  — callable that runs a git command and returns
//     {code, stdout, stderr}. Defaults to spawnSync-backed impl.
//   - opts.httpFetch — fetch impl for the GitHub API call.
//   - opts.nowEpochSeconds — for cache timestamps + relationship
//     freshness (matches Python).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const UPDATE_REMOTE_REPO = "fxspeiser/crosscheck-agent";
const UPDATE_REMOTE_URL  = `https://github.com/${UPDATE_REMOTE_REPO}`;
const UPDATE_API_URL     = `https://api.github.com/repos/${UPDATE_REMOTE_REPO}/commits/main`;

const SHA_RE = /^[0-9a-f]{7,64}$/;

export interface GitRunResult {
  code:   number;
  stdout: string;
  stderr: string;
}

export interface RunUpdateCrosscheckOptions {
  /** Repo root — gitRun runs in this cwd; cache file is written
   *  alongside the repo's .crosscheck/ dir. Required. */
  repoRoot:        string;
  /** Override the git command runner. Defaults to spawnSync. */
  gitRun?:         (args: readonly string[], opts?: { timeoutMs?: number }) => GitRunResult;
  /** Override the HTTP fetcher. Defaults to globalThis.fetch. */
  httpFetch?:      typeof fetch;
  /** Epoch seconds — used in cache file timestamps. */
  nowEpochSeconds?: () => number;
  /** Path to the cache file. Defaults to
   *  `<repoRoot>/.crosscheck/update_check.json`. */
  cachePath?:      string;
}

export async function runUpdateCrosscheck(
  args: Record<string, unknown>,
  opts: RunUpdateCrosscheckOptions,
): Promise<Record<string, unknown>> {
  const applyNow = Boolean(args["apply"]);
  const gitRun   = opts.gitRun  ?? defaultGitRun(opts.repoRoot);
  const fetchFn  = opts.httpFetch ?? globalThis.fetch;
  const now      = opts.nowEpochSeconds
                    ? opts.nowEpochSeconds()
                    : Math.floor(Date.now() / 1000);
  const cachePath = opts.cachePath
    ?? path.join(opts.repoRoot, ".crosscheck", "update_check.json");

  // 1. Local SHA.
  const local = readLocalSha(gitRun);
  if (!local) {
    return {
      tool: "update_crosscheck", status: "error",
      reason: "could not determine local git SHA. crosscheck-agent must be " +
              "installed as a git checkout for in-place updates.",
      remote_url: UPDATE_REMOTE_URL,
    };
  }

  // 2. Remote SHA via GitHub API.
  const remote = await readRemoteMainSha(fetchFn, 10_000);
  if (!remote) {
    return {
      tool: "update_crosscheck", status: "error",
      reason: "could not reach https://api.github.com to check for updates.",
      current_sha: local.slice(0, 12),
      remote_url: UPDATE_REMOTE_URL,
    };
  }

  // 3. Git relationship.
  const [rel, ahead, behind] = gitRelationship(gitRun, local, remote);
  const base = {
    tool: "update_crosscheck",
    current_sha: local.slice(0, 12),
    latest_sha:  remote.slice(0, 12),
    relationship: rel,
    ahead,
    behind,
    update_available: rel === "behind",
    remote_url: UPDATE_REMOTE_URL,
  };
  const cacheRecord: Record<string, unknown> = {
    checked_at:       now,
    current_sha:      local,
    latest_sha:       remote,
    relationship:     rel,
    ahead, behind,
    update_available: rel === "behind",
  };

  if (rel === "equal") {
    writeUpdateCache(cachePath, cacheRecord);
    return { ...base, status: "up_to_date" };
  }
  if (rel === "ahead") {
    writeUpdateCache(cachePath, cacheRecord);
    return {
      ...base, status: "local_ahead",
      next_step: `Your local HEAD is ${ahead} commit(s) ahead of ` +
                 `origin/main. There is no remote upgrade to apply. ` +
                 `Push with \`git push origin main\` if these commits ` +
                 `are ready to publish.`,
    };
  }
  if (rel === "diverged") {
    writeUpdateCache(cachePath, cacheRecord);
    return {
      ...base, status: "diverged",
      next_step: `Local and remote have diverged ` +
                 `(ahead ${ahead}, behind ${behind}). Resolve ` +
                 `manually with \`git status\` and a rebase or merge. ` +
                 `Refusing to fast-forward through a divergence.`,
    };
  }
  if (rel === "unknown") {
    writeUpdateCache(cachePath, cacheRecord);
    return {
      ...base, status: "error",
      reason: "could not determine ancestry between local HEAD and " +
              "remote main. Likely causes: no `origin` remote, " +
              "git fetch failed, or remote SHA not reachable. The " +
              "SHAs differ but it is unsafe to assume an upgrade direction.",
    };
  }

  // rel === "behind"
  if (!applyNow) {
    const notice = buildUpdateNotice(local, remote, behind ?? null);
    writeUpdateCache(cachePath, { ...cacheRecord, notice });
    return {
      ...base, status: "update_available",
      next_step: `You are ${behind} commit(s) behind origin/main. ` +
                 `Re-run with apply=true to fast-forward. After it ` +
                 `succeeds, restart Claude Code (or the MCP ` +
                 `connection) so the server reloads the new code.`,
    };
  }

  // Fast-forward pull.
  const pull = gitRun(["pull", "--ff-only"], { timeoutMs: 60_000 });
  if (pull.code === -1) {
    return {
      ...base, status: "pull_failed",
      error: pull.stderr || "git command failed",
    };
  }
  if (pull.code !== 0) {
    return {
      ...base, status: "pull_failed",
      exit_code: pull.code,
      stderr: pull.stderr.slice(-1024),
      stdout: pull.stdout.slice(-512),
      next_step: "git pull failed — likely uncommitted local changes or a " +
                 "non-fast-forward divergence. Resolve manually with " +
                 "`git status && git pull --rebase` and retry.",
    };
  }
  const newLocal = readLocalSha(gitRun) ?? local;
  writeUpdateCache(cachePath, {
    checked_at: now,
    update_available: newLocal !== remote,
    current_sha: newLocal,
    latest_sha:  remote,
  });
  return {
    ...base,
    status:           "updated",
    new_sha:          newLocal.slice(0, 12),
    stdout:           pull.stdout.slice(-512),
    restart_required: true,
    restart_instructions: (
      "The MCP server cannot reload its own code. To pick up the new " +
      "version: in Claude Code, run `/mcp` and reconnect to the " +
      "crosscheck server, or restart your Claude Code session."
    ),
  };
}

// ---------- pure helpers ----------

function defaultGitRun(repoRoot: string): (args: readonly string[], opts?: { timeoutMs?: number }) => GitRunResult {
  return (args, opts) => {
    try {
      const cp = spawnSync("git", args as string[], {
        cwd: repoRoot,
        timeout: opts?.timeoutMs ?? 5_000,
        encoding: "utf8",
      });
      return {
        code:   typeof cp.status === "number" ? cp.status : -1,
        stdout: cp.stdout ?? "",
        stderr: cp.stderr ?? "",
      };
    } catch (e) {
      return { code: -1, stdout: "", stderr: (e as Error).message ?? String(e) };
    }
  };
}

function readLocalSha(gitRun: (args: readonly string[]) => GitRunResult): string | null {
  const cp = gitRun(["rev-parse", "HEAD"]);
  if (cp.code !== 0) return null;
  const sha = cp.stdout.trim();
  return SHA_RE.test(sha) ? sha : null;
}

async function readRemoteMainSha(
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const resp = await withTimeout(
      fetchFn(UPDATE_API_URL, {
        headers: {
          "User-Agent": "crosscheck-agent/update-check",
          Accept: "application/vnd.github+json",
        },
      }),
      timeoutMs,
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { sha?: unknown };
    if (typeof data?.sha !== "string") return null;
    return SHA_RE.test(data.sha) ? data.sha : null;
  } catch {
    return null;
  }
}

type Relationship = "equal" | "ahead" | "behind" | "diverged" | "unknown";

function gitRelationship(
  gitRun: (args: readonly string[], opts?: { timeoutMs?: number }) => GitRunResult,
  local: string, remote: string,
): [Relationship, number | null, number | null] {
  if (local === remote) return ["equal", 0, 0];
  // Best-effort fetch so the remote SHA is in our local object DB.
  gitRun(["fetch", "origin", "main"], { timeoutMs: 15_000 });
  const exists = gitRun(["cat-file", "-e", remote]);
  if (exists.code !== 0) return ["unknown", null, null];
  const a = gitRun(["rev-list", "--count", `${remote}..HEAD`]);
  const b = gitRun(["rev-list", "--count", `HEAD..${remote}`]);
  if (a.code !== 0 || b.code !== 0) return ["unknown", null, null];
  const ahead  = Number(a.stdout.trim());
  const behind = Number(b.stdout.trim());
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return ["unknown", null, null];
  if (ahead === 0 && behind === 0) return ["equal", 0, 0];
  if (ahead  > 0 && behind === 0) return ["ahead", ahead, 0];
  if (ahead === 0 && behind  > 0) return ["behind", 0, behind];
  return ["diverged", ahead, behind];
}

function writeUpdateCache(p: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // Cache write is best-effort; never let it break the response.
  }
}

function buildUpdateNotice(
  local: string, remote: string, behindCount: number | null,
): Record<string, unknown> {
  const behindPhrase = (behindCount !== null && behindCount > 0)
    ? `You are ${behindCount} commit(s) behind.`
    : `Your local HEAD is ${local.slice(0, 8)}; remote is ${remote.slice(0, 8)}.`;
  return {
    update_available: true,
    current_sha: local.slice(0, 12),
    latest_sha:  remote.slice(0, 12),
    behind_count: behindCount,
    remote_url:  UPDATE_REMOTE_URL,
    message: (
      `crosscheck-agent: a newer version is available. ${behindPhrase} ` +
      `To upgrade, call \`update_crosscheck\` with apply=true; the user must ` +
      `then restart Claude Code (or the MCP connection) to load the new code. ` +
      `Ask the user before applying.`
    ),
    ask_user: true,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// suppress unused-import warning for existsSync (kept available for
// future helpers that might need it; keeping the import live now lets
// the cache-file caller use it without a second import edit).
void existsSync;

export const __test_internals = {
  UPDATE_REMOTE_REPO, UPDATE_REMOTE_URL, UPDATE_API_URL,
  SHA_RE, gitRelationship, buildUpdateNotice, readLocalSha,
};
