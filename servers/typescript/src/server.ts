// crosscheck-agent MCP server — TypeScript port.
//
// Phase 0 (bootstrap): the smallest server that proves the @modelcontextprotocol/sdk
// wire is working. Adds a single `ping` tool that echoes the server's commit-ish
// version. Subsequent phases will add the real tool surface.
//
// Architecture: a transport-agnostic `Server` object. The entrypoint files
// (entrypoints/node-stdio.ts, entrypoints/node-http.ts, entrypoints/browser-ext.ts)
// supply the concrete transport — the server itself doesn't know how the bytes
// arrive.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { Storage } from "./adapters/storage/interface.js";
import { type BridgeHandle, buildPythonProxies } from "./bridge/index.js";
import type { Provider } from "./providers/types.js";
import { registerCoreTools, type Tool } from "./tools/index.js";

export const SERVER_NAME = "crosscheck-agent";
export const SERVER_VERSION = "0.1.0-alpha.0";

export interface CreateServerOptions {
  /** Optional Python bridge. When supplied, the bridge's tools are
   *  merged into the registry as proxy entries — they forward `tools/call`
   *  to the Python child. In Phase 4 this is route-all mode (every
   *  tool name comes from Python); in Phase 5+ native TS tools
   *  override per-name. */
  bridge?: BridgeHandle;
  /** Native LLM providers, keyed by lowercased name. Threaded into
   *  pick / audit / confer via the tool registry. When absent, those
   *  tools return a clear "no providers" error (or defer to the bridge
   *  if one is wired). */
  providers?: Readonly<Record<string, Provider>>;
  /** Optional provider allowlist. */
  providerAllowlist?: readonly string[] | null;
  /** SQLite-backed storage adapter. Threaded into recall / scoreboard /
   *  session_memory / explain via the tool registry. */
  storage?: Storage;
  /** Directory holding transcript JSON files (used by `explain`). */
  transcriptsDir?: string;
  /** Repo root path (`.git/` ancestor). Used by update_crosscheck for
   *  git ops + cache writes, and by `fetch` for evidence-dir resolution. */
  repoRoot?: string;
}

/**
 * Create a not-yet-connected MCP server with the current tool surface
 * registered. The caller is responsible for connecting it to a Transport.
 *
 * When `opts.bridge` is supplied, the Python tool surface is merged in
 * via proxy handlers — TS-native tools win on name collisions so we can
 * cut over per-tool in Phase 5 without restarting.
 */
export function createServer(opts: CreateServerOptions = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = buildToolRegistry(opts);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const out = await tool.handler(args);
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  });

  return server;
}

/**
 * Connect a server to a transport and start serving. Pure plumbing — kept
 * here so the entrypoint files stay short.
 */
export async function connectAndServe(
  transport: Transport,
  opts: CreateServerOptions = {},
): Promise<Server> {
  const server = createServer(opts);
  await server.connect(transport);
  return server;
}

/** Merge native TS tools with bridge proxies. Native wins on name
 *  collisions so per-tool cutover works without restart: ship a TS
 *  port, ship the new server build, and the bridge proxy for that
 *  name silently gets shadowed.
 *
 *  The bridge is also threaded INTO native tools that need it for
 *  not-yet-ported sub-features (e.g. verify's shell + url_head). */
function buildToolRegistry(opts: CreateServerOptions): Map<string, Tool> {
  const registerOpts: Parameters<typeof registerCoreTools>[0] = {};
  if (opts.bridge)            registerOpts.bridge            = opts.bridge;
  if (opts.providers)         registerOpts.providers         = opts.providers;
  if (opts.providerAllowlist !== undefined)
    registerOpts.providerAllowlist = opts.providerAllowlist;
  if (opts.storage)           registerOpts.storage           = opts.storage;
  if (opts.transcriptsDir)    registerOpts.transcriptsDir    = opts.transcriptsDir;
  if (opts.repoRoot)          registerOpts.repoRoot          = opts.repoRoot;
  const tools = registerCoreTools(registerOpts);
  if (!opts.bridge) return tools;
  const proxies = buildPythonProxies(opts.bridge);
  for (const [name, proxy] of proxies) {
    // Native tool wins on collision (Phase-5 cutover behavior).
    if (!tools.has(name)) tools.set(name, proxy);
  }
  return tools;
}
