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

import { existsSync } from "node:fs";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { spawnPythonBridge, type BridgeHandle } from "../bridge/index.js";
import { loadPricing } from "../core/pricing.js";
import { buildProviders } from "../providers/registry.js";
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

  // Build the native provider registry from env. Pricing comes from
  // config/pricing.json (sibling at repo root). Both are optional: a
  // server with no API keys + no pricing file still serves the
  // deterministic tools (verify) and the bridge proxies (everything
  // else) — only the LLM-native paths (pick / audit / confer) require
  // providers.
  const pricingPath = process.env["CROSSCHECK_PRICING_PATH"]
    ?? resolveRepoFile("config/pricing.json");
  const pricing = pricingPath && existsSync(pricingPath) ? loadPricing(pricingPath) : {};
  const providers = buildProviders({ env: process.env, pricing });
  if (Object.keys(providers).length > 0) {
    process.stderr.write(
      `crosscheck-agent: native providers loaded: ${Object.keys(providers).sort().join(", ")}\n`,
    );
  }

  const transport = new StdioServerTransport();
  const serverOpts: Parameters<typeof connectAndServe>[1] = { providers };
  if (bridge) serverOpts.bridge = bridge;
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

/** Walk up from this file's directory looking for the given repo-relative
 *  path. Works both in `src/entrypoints/` (dev via tsx) and `dist/` (prod). */
function resolveRepoFile(rel: string): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

main().catch((err) => {
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crosscheck-agent: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
