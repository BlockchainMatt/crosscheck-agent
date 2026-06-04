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

import { registerCoreTools } from "./tools/index.js";

export const SERVER_NAME = "crosscheck-agent";
export const SERVER_VERSION = "0.1.0-alpha.0";

/**
 * Create a not-yet-connected MCP server with the current tool surface
 * registered. The caller is responsible for connecting it to a Transport.
 */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = registerCoreTools();

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
export async function connectAndServe(transport: Transport): Promise<Server> {
  const server = createServer();
  await server.connect(transport);
  return server;
}
