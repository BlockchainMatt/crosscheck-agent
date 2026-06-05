// Tiny HTTP cassette store for offline parity testing.
//
// A cassette is a JSON file containing one or more recorded request/response
// pairs. Tests inject `replayFromCassette(path)` as the fetch impl; live
// runs use Node's built-in `fetch`. No external recording — cassettes are
// hand-written or captured once via a dedicated helper script (Phase-3
// part-2 onwards if needed).
//
// We deliberately don't ship a record mode here — cassettes are committed
// to the repo and the CI matrix replays them. The cost of "go re-record"
// is one minute of operator time once a year; the win is deterministic CI.

export interface CassetteRequest {
  method: string;
  url: string;
  /** Optional header-equality check. Tests typically only assert
   *  presence/content of provider-specific headers (e.g. x-api-key
   *  shape) rather than every header. */
  headers?: Record<string, string>;
  /** Request body shape — we compare structurally (deepEqual after
   *  JSON.parse), not byte-for-byte, to avoid key-order sensitivity. */
  body?: unknown;
}

export interface CassetteResponse {
  status: number;
  headers?: Record<string, string>;
  /** JSON body the cassette returns. */
  body: unknown;
}

export interface CassetteEntry {
  label: string;
  request: CassetteRequest;
  response: CassetteResponse;
}

export interface Cassette {
  /** Free-form description, e.g. "anthropic basic claude-test". */
  description?: string;
  entries: readonly CassetteEntry[];
}

/** Minimal fetch-like contract — what every provider adapter accepts as
 *  its HTTP injection point. Returns a Response-shaped object (status +
 *  json + text). */
export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    status: number;
    headers: Record<string, string>;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

/** Build a fetch shim that returns the matching cassette entry's
 *  response. Match strategy: method + url exact; body shape via deep
 *  equality after JSON.parse. Throws when nothing matches — caller
 *  should let it propagate so the test fails loudly. */
export function replayFromCassette(cassette: Cassette): FetchLike {
  let cursor = 0;
  return async (url, init) => {
    if (cursor >= cassette.entries.length) {
      throw new Error(
        `cassette exhausted (${cassette.entries.length} entries) — ` +
        `caller tried to fetch ${init.method} ${url}`,
      );
    }
    const entry = cassette.entries[cursor]!;
    cursor++;
    if (entry.request.method !== init.method) {
      throw new Error(
        `cassette[${cursor - 1}] '${entry.label}' expected method ` +
        `${entry.request.method}, got ${init.method}`,
      );
    }
    if (entry.request.url !== url) {
      throw new Error(
        `cassette[${cursor - 1}] '${entry.label}' expected url ` +
        `${entry.request.url}, got ${url}`,
      );
    }
    if (entry.request.body !== undefined) {
      const actual = init.body ? JSON.parse(init.body) : null;
      if (!deepEqual(entry.request.body, actual)) {
        throw new Error(
          `cassette[${cursor - 1}] '${entry.label}' request body mismatch.\n` +
          `expected: ${JSON.stringify(entry.request.body)}\n` +
          `actual:   ${JSON.stringify(actual)}`,
        );
      }
    }
    const respHeaders = entry.response.headers ?? {};
    const respJson    = entry.response.body;
    const respText    = typeof respJson === "string" ? respJson : JSON.stringify(respJson);
    return {
      status:  entry.response.status,
      headers: respHeaders,
      text:    async () => respText,
      json:    async () => respJson,
    };
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}
