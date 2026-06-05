// Node-stdio entrypoint. Spawned as a subprocess by hosts like Claude
// Desktop / Cursor / Claude Code; speaks MCP JSON-RPC over stdin/stdout.
// This file is THIN by design — all the wiring lives in src/server.ts.
//
// Bridge mode (Phase 4): when `CROSSCHECK_BRIDGE_PYTHON=1`, the TS
// entrypoint spawns the Python crosscheck-agent as an MCP stdio child
// and forwards every tool call to it. Per-tool routing (Phase 5+) will
// add native TS handlers that shadow the bridge proxies for individual
// tools as they port.
//
// Lifecycle (Phase 4.1): when the host kills us (SIGTERM / SIGINT) or
// closes our stdin, we propagate cleanup to the Python child via
// bridge.close() before exiting. Without this, a host crash leaks an
// orphan Python process per session.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { spawnPythonBridge, type BridgeHandle } from "../bridge/index.js";
import { connectAndServe } from "../server.js";

/** Soft deadline for cleanup before we hard-exit. Hosts typically give
 *  a process ~5 s after SIGTERM before SIGKILL, so we want to be done
 *  well inside that window. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

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
      `crosscheck-agent: bridge online (pid=${bridge.pid ?? "?"}); proxying ${bridge.toolNames.size} Python tool(s)\n`,
    );
  }

  installShutdownHandlers(bridge);

  const transport = new StdioServerTransport();
  const serverOpts = bridge ? { bridge } : {};
  await connectAndServe(transport, serverOpts);
  // The server holds the process alive via the stdio streams. We don't
  // exit until the parent closes stdin (handled below).
}

/** Wire the OS-level lifecycle plumbing so the Python child gets reaped
 *  on every exit path a host might trigger. Idempotent — the first
 *  trigger wins; subsequent signals during cleanup are ignored. */
function installShutdownHandlers(bridge: BridgeHandle | undefined): void {
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (bridge) {
      // Race bridge.close() against a short deadline — we don't want
      // a stuck Python child to keep us alive past the host's SIGKILL.
      await Promise.race([
        bridge.close(),
        new Promise<void>((resolve) =>
          setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
        ),
      ]).catch(() => { /* best-effort */ });
    }
    // Tag the reason in stderr so post-mortem logs make sense.
    process.stderr.write(`crosscheck-agent: shutdown (${reason})\n`);
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT");  });
  // When the host closes our stdin (the normal MCP graceful shutdown),
  // the stdio transport will stop reading but won't exit the process
  // by itself. We hook stdin-end and close to make sure we tear down.
  process.stdin.on("end",   () => { void shutdown("stdin-end");   });
  process.stdin.on("close", () => { void shutdown("stdin-close"); });
}

main().catch((err) => {
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crosscheck-agent: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
