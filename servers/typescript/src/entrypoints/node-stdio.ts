// Node-stdio entrypoint. Spawned as a subprocess by hosts like Claude
// Desktop / Cursor / Claude Code; speaks MCP JSON-RPC over stdin/stdout.
// This file is THIN by design — all the wiring lives in src/server.ts.
//
// Bridge mode (Phase 4): when `CROSSCHECK_BRIDGE_PYTHON=1`, the TS
// entrypoint spawns the Python crosscheck-agent as an MCP stdio child
// and forwards every tool call to it. Per-tool routing (Phase 5+) will
// add native TS handlers that shadow the bridge proxies for individual
// tools as they port.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { spawnPythonBridge, type BridgeHandle } from "../bridge/index.js";
import { connectAndServe } from "../server.js";

async function main(): Promise<void> {
  let bridge: BridgeHandle | undefined;
  if (process.env["CROSSCHECK_BRIDGE_PYTHON"] === "1") {
    bridge = await spawnPythonBridge({
      ...(process.env["CROSSCHECK_PYTHON_PATH"]
        ? { pythonPath: process.env["CROSSCHECK_PYTHON_PATH"] }
        : {}),
      ...(process.env["CROSSCHECK_PYTHON_SERVER"]
        ? { serverPath: process.env["CROSSCHECK_PYTHON_SERVER"] }
        : {}),
    });
    process.stderr.write(
      `crosscheck-agent: bridge online; proxying ${bridge.toolNames.size} Python tool(s)\n`,
    );
  }

  const transport = new StdioServerTransport();
  const serverOpts = bridge ? { bridge } : {};
  await connectAndServe(transport, serverOpts);
  // The server holds the process alive via the stdio streams. We don't
  // exit until the parent closes stdin.
}

main().catch((err) => {
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crosscheck-agent: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
