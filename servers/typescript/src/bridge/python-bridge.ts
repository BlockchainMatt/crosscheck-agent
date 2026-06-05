// Python↔TS MCP-over-MCP bridge.
//
// The TS server spawns the Python `crosscheck_server.py` as an MCP
// stdio child and talks to it via @modelcontextprotocol/sdk's Client.
// Used in two modes:
//
//   1. Route-all (Phase 4 exit gate): every TS tool call is forwarded
//      to Python. The TS server adds NO behavior; the only TS code on
//      the path is the transport. Proves the bridge layer doesn't drop
//      bytes.
//   2. Per-tool routing (Phase 5+): TS dispatches tools natively when
//      they're ported, forwards the rest to Python. Cutover happens
//      tool-by-tool with byte-equal CI gates.
//
// We don't ship restart-on-crash here — Phase 4 is about correctness,
// not durability. A crashed Python child surfaces as a thrown error
// and the TS process exits. Long-running production bridges should
// supervise the child; that's polish work for after cutover.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Configuration for the bridge. All fields optional — sensible defaults
 *  are resolved from the package layout. */
export interface PythonBridgeOptions {
  /** Path to the Python interpreter. Defaults to `python3`. */
  pythonPath?: string;
  /** Path to `crosscheck_server.py`. Defaults to the sibling
   *  `servers/python/crosscheck_server.py` in the repo. */
  serverPath?: string;
  /** Extra args to pass to the Python interpreter (e.g. `-u` for
   *  unbuffered stdio if needed; the SDK transport handles framing). */
  extraArgs?: string[];
  /** Extra env vars to merge with `process.env` for the child. */
  env?: Record<string, string>;
  /** Soft timeout for the initial handshake + tools/list, in ms.
   *  Default 30s — long enough for cold Python imports on slow disks. */
  initTimeoutMs?: number;
}

/** Default location of the Python server source, derived from this
 *  file's path. Works whether we're running source TS via tsx, or the
 *  bundled CJS/ESM out of dist/. */
function defaultServerPath(): string {
  // Production CJS bundle: dist/node-stdio.cjs
  // Production ESM bundle: dist/node-stdio.js
  // Dev: src/bridge/python-bridge.ts
  //
  // In all three, the Python server lives at ../../python/crosscheck_server.py
  // relative to the file's directory (servers/typescript/{src/bridge or dist}).
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback — __dirname-equivalent for the bundled CJS file.
    here = __dirname;
  }
  // Walk up from <pkg>/{dist | src/bridge} to <pkg>/.. → repo/servers,
  // then into python/.
  // src/bridge → pkg root is ../..
  // dist       → pkg root is ..
  // We use a heuristic: if the file path contains "/src/bridge", go up 2;
  // otherwise (dist build), go up 1.
  const upToPkg = here.includes(`${path.sep}src${path.sep}bridge`) ? "../.." : "..";
  return path.resolve(here, upToPkg, "..", "python", "crosscheck_server.py");
}

/** A live bridge to a Python crosscheck-agent child. */
export interface BridgeHandle {
  /** Names of the tools exposed by the Python child (from its
   *  `tools/list` response). */
  readonly toolNames: ReadonlySet<string>;
  /** Forward a `tools/call` to the Python child and return the result
   *  envelope verbatim. */
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
  /** Re-fetch the tool list (in case the child surfaces new tools mid-
   *  session). Returns the new tool names. */
  refreshTools(): Promise<ReadonlySet<string>>;
  /** Tear down the bridge cleanly. */
  close(): Promise<void>;
}

/** Spawn the Python server and complete the MCP handshake.
 *
 *  Returns a `BridgeHandle` with the Python tool list already fetched
 *  (so route-all mode doesn't have to await on every call).
 *
 *  Throws if the handshake fails within `initTimeoutMs`. */
export async function spawnPythonBridge(
  opts: PythonBridgeOptions = {},
): Promise<BridgeHandle> {
  const pythonPath = opts.pythonPath ?? "python3";
  const serverPath = opts.serverPath ?? defaultServerPath();
  const args       = [...(opts.extraArgs ?? []), serverPath];

  const transport = new StdioClientTransport({
    command: pythonPath,
    args,
    env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
  });

  const client = new Client(
    { name: "crosscheck-agent-bridge", version: "0.1.0-alpha.0" },
    { capabilities: {} },
  );

  const initDeadline = opts.initTimeoutMs ?? 30_000;
  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`bridge: handshake timeout after ${initDeadline}ms`)),
        initDeadline,
      ),
    ),
  ]);

  // Fetch the tool list once. We surface it as a Set for O(1) routing.
  let toolNames = await fetchToolNames(client, initDeadline);

  return {
    get toolNames() {
      return toolNames;
    },
    async callTool(name, callArgs) {
      const r = await client.callTool({ name, arguments: callArgs });
      // The SDK types the response as a discriminated union; we narrow
      // here. content[].text is the JSON-stringified tool result —
      // identical to the Python server's wire format.
      const content = (r as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        throw new Error(
          `bridge: tools/call(${name}) returned a malformed envelope: ${JSON.stringify(r).slice(0, 200)}`,
        );
      }
      const out: { type: string; text: string }[] = [];
      for (const c of content) {
        if (c && typeof c === "object") {
          const co = c as Record<string, unknown>;
          out.push({
            type: String(co["type"] ?? "text"),
            text: typeof co["text"] === "string" ? co["text"] : JSON.stringify(co["text"]),
          });
        }
      }
      const isError = (r as { isError?: boolean }).isError;
      return isError !== undefined
        ? { content: out, isError }
        : { content: out };
    },
    async refreshTools() {
      toolNames = await fetchToolNames(client, initDeadline);
      return toolNames;
    },
    async close() {
      try {
        await client.close();
      } catch {
        // Best-effort; the transport may already be shut down.
      }
    },
  };
}

async function fetchToolNames(
  client: Client, timeoutMs: number,
): Promise<ReadonlySet<string>> {
  const r = await Promise.race([
    client.listTools(),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`bridge: tools/list timeout after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
  const tools = (r as { tools?: { name?: string }[] }).tools ?? [];
  return new Set(
    tools.map((t) => String(t?.name ?? "")).filter((n) => n.length > 0),
  );
}
