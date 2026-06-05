// Native TS port of Python's `tool_fetch` — Phase 5 part 20.
//
// HTTP retrieval with allowlist gating, per-session egress budget,
// and sha256-content-addressed evidence storage. Mirrors Python's
// shape exactly except for:
//   - Uses Node's global fetch (Node 18+) for the HTTP call.
//   - `path` is emitted relative to opts.repoRoot when the path
//     starts under it; otherwise absolute. Matches Python's
//     `body_path.relative_to(ROOT)` fallback chain.
//   - Storage methods used: getFetchEgressTotals,
//     hasFetchEgressHost, recordFetchEgress.
//
// SCOPE for v1:
//   - GET-only (matches Python).
//   - User-Agent: "crosscheck-agent/0.1" (matches Python).
//   - max_bytes cap during the read.
//   - URL allowlist (prefix match — matches Python's
//     `any(url.startswith(p) for p in allowlist)`).
//   - Per-session caps: max_bytes_per_session, max_unique_hosts_per_session.
//   - SHA256 evidence under evidence_dir/{sha}.bin + by-url-{hash16}.json.
//   - Cache: when meta_path exists and !force_refresh, return cached.
//
// No bridge fallback path needed — fetch's behavior is entirely
// determined by config + storage; if storage is missing, the
// per-session cap simply degrades to "unlimited" (matches the
// Python except: pass on the stats query).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BridgeHandle } from "../bridge/index.js";
import type { Storage } from "../adapters/storage/interface.js";

export interface FetchConfig {
  enabled?:                       boolean;
  url_allowlist?:                 readonly string[];
  max_bytes?:                     number;
  max_bytes_per_session?:         number;
  max_unique_hosts_per_session?:  number;
  timeout_s?:                     number;
  evidence_dir?:                  string;
}

export interface RunFetchOptions {
  /** Tool config — typically CFG.fetch from the host's config file. */
  config?:    FetchConfig;
  /** Storage adapter (for egress accounting). When absent, caps are
   *  silently treated as disabled (matches Python's except-pass). */
  storage?:   Storage;
  bridge?:    BridgeHandle;
  /** Repo root for relative-path emission in the result envelope.
   *  When absent, paths are emitted absolute. */
  repoRoot?:  string;
  /** fetch() impl injection — defaults to globalThis.fetch. Tests
   *  supply a mock. */
  fetchImpl?: typeof fetch;
  /** Epoch seconds for the fetched_at meta field + egress last_at. */
  nowEpochSeconds?: () => number;
}

/** Default config values match Python's `_fetch_cfg()` fallbacks. */
const DEFAULT_CONFIG: Required<FetchConfig> = {
  enabled:                      true,
  url_allowlist:                [],
  max_bytes:                    10 * 1024 * 1024,
  max_bytes_per_session:        0,
  max_unique_hosts_per_session: 0,
  timeout_s:                    15,
  evidence_dir:                 ".crosscheck/evidence",
};

export async function runFetch(
  args: Record<string, unknown>,
  opts: RunFetchOptions,
): Promise<Record<string, unknown>> {
  const url       = String(args["url"] ?? "");
  const force     = Boolean(args["force_refresh"]);
  const sessionId = typeof args["session_id"] === "string" ? args["session_id"] : null;
  const cfg       = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };

  const base: Record<string, unknown> = { tool: "fetch", url };

  if (!cfg.enabled) {
    return { ...base, accepted: false, reason: "fetch is disabled" };
  }
  if (!(url.startsWith("https://") || url.startsWith("http://"))) {
    return { ...base, accepted: false, reason: "only http/https schemes are supported" };
  }
  if (cfg.url_allowlist.length === 0) {
    return {
      ...base, accepted: false,
      reason: "fetch.url_allowlist is empty; no URLs may be fetched",
    };
  }
  if (!isUrlAllowed(url, cfg.url_allowlist)) {
    return {
      ...base, accepted: false,
      reason: "url is not covered by fetch.url_allowlist",
      allowlist: cfg.url_allowlist,
    };
  }

  // Egress caps. 0 disables either cap.
  const maxBytesSession = Math.max(0, cfg.max_bytes_per_session);
  const maxUniqueHosts  = Math.max(0, cfg.max_unique_hosts_per_session);
  const host = extractHost(url);

  if (sessionId && opts.storage && (maxBytesSession > 0 || maxUniqueHosts > 0)) {
    const { total_bytes, unique_hosts } = await opts.storage.getFetchEgressTotals(sessionId);
    if (maxBytesSession > 0 && total_bytes >= maxBytesSession) {
      return {
        ...base, accepted: false,
        ...errorPayload(
          "FETCH_EGRESS_BYTES_EXCEEDED",
          `session ${sessionId} has already pulled ${total_bytes} bytes; ` +
            `cap is ${maxBytesSession}`,
          "Raise `fetch.max_bytes_per_session` or start a new session_id.",
          "config",
        ),
        session_id: sessionId, host,
        total_bytes, cap_bytes: maxBytesSession,
      };
    }
    if (maxUniqueHosts > 0 && host && unique_hosts >= maxUniqueHosts) {
      const alreadySeen = await opts.storage.hasFetchEgressHost(sessionId, host);
      if (!alreadySeen) {
        return {
          ...base, accepted: false,
          ...errorPayload(
            "FETCH_EGRESS_HOSTS_EXCEEDED",
            `session ${sessionId} has contacted ${unique_hosts} unique hosts; ` +
              `cap is ${maxUniqueHosts}`,
            "Raise `fetch.max_unique_hosts_per_session` or start a new session_id.",
            "config",
          ),
          session_id: sessionId, host,
          unique_hosts, cap_hosts: maxUniqueHosts,
        };
      }
    }
  }

  // Evidence dir + cache check.
  const evDir = resolveEvidenceDir(cfg.evidence_dir, opts.repoRoot);
  const urlHash16 = sha256Hex(url).slice(0, 16);
  const metaPath = path.join(evDir, `by-url-${urlHash16}.json`);
  if (existsSync(metaPath) && !force) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as
        { sha256: string; bytes: number; path: string };
      return {
        ...base, accepted: true, cached: true,
        sha256: meta.sha256, bytes: meta.bytes, path: meta.path,
      };
    } catch {
      // fall through to re-fetch
    }
  }

  // HTTP call. Node's fetch is global; tests inject a mock.
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await withTimeout(
      fetchFn(url, { headers: { "User-Agent": "crosscheck-agent/0.1" } }),
      cfg.timeout_s * 1000,
    );
  } catch (e) {
    return {
      ...base, accepted: false,
      reason: `network error: ${(e as Error).message ?? String(e)}`,
    };
  }
  if (!response.ok) {
    let body = "";
    try { body = (await response.text()).slice(0, 256); } catch { /* ignore */ }
    return {
      ...base, accepted: false,
      reason: `HTTP ${response.status}: ${body}`,
    };
  }

  // Stream + cap at max_bytes.
  let data: Uint8Array;
  try {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > cfg.max_bytes) {
      return {
        ...base, accepted: false,
        reason: `response exceeds max_bytes=${cfg.max_bytes}`,
      };
    }
    data = new Uint8Array(buf);
  } catch (e) {
    return {
      ...base, accepted: false,
      reason: `${(e as Error).name ?? "Error"}: ${(e as Error).message ?? String(e)}`,
    };
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  const status = response.status;

  // SHA-256 the body + write evidence files.
  const sha = sha256HexBytes(data);
  const bodyPath = path.join(evDir, `${sha}.bin`);
  mkdirSync(evDir, { recursive: true });
  writeFileSync(bodyPath, data);
  const relBody = makeRelative(bodyPath, opts.repoRoot);
  const now = opts.nowEpochSeconds ? opts.nowEpochSeconds() : Math.floor(Date.now() / 1000);
  const meta = {
    url, sha256: sha, bytes: data.byteLength,
    path: relBody, content_type: contentType, status,
    fetched_at: now,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Record egress against the session (best-effort).
  if (sessionId && host && opts.storage) {
    try {
      await opts.storage.recordFetchEgress(sessionId, host, data.byteLength, now);
    } catch {
      // Match Python: never break the fetch on accounting failures.
    }
  }

  return {
    ...base, accepted: true, cached: false,
    sha256: sha, bytes: data.byteLength, path: relBody,
    content_type: contentType, status, host,
  };
}

// ---------- helpers ----------

function isUrlAllowed(url: string, allowlist: readonly string[]): boolean {
  return allowlist.some((prefix) => url.startsWith(prefix));
}

function extractHost(url: string): string {
  try {
    return (new URL(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function sha256HexBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveEvidenceDir(configured: string, repoRoot: string | undefined): string {
  if (path.isAbsolute(configured)) return configured;
  if (repoRoot) return path.resolve(repoRoot, configured);
  return path.resolve(configured);
}

function makeRelative(p: string, repoRoot: string | undefined): string {
  if (repoRoot && p.startsWith(repoRoot)) {
    const rel = path.relative(repoRoot, p);
    // Python's relative_to drops the leading "./" — match that.
    return rel.length > 0 ? rel : ".";
  }
  return p;
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

function errorPayload(
  code: string, message: string, hint: string, kind = "client",
): Record<string, unknown> {
  return {
    error:         message,
    error_code:    code,
    error_kind:    kind,
    operator_hint: hint,
    transient:     false,
  };
}

export const __test_internals = {
  DEFAULT_CONFIG, isUrlAllowed, extractHost, sha256Hex, makeRelative,
};
