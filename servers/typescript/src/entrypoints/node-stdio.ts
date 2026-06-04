// Node-stdio entrypoint. Spawned as a subprocess by hosts like Claude
// Desktop / Cursor / Claude Code; speaks MCP JSON-RPC over stdin/stdout.
// This file is THIN by design — all the wiring lives in src/server.ts.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { connectAndServe } from "../server.js";

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await connectAndServe(transport);
  // The server holds the process alive via the stdio streams. We don't
  // exit until the parent closes stdin.
}

main().catch((err) => {
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crosscheck-agent: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
