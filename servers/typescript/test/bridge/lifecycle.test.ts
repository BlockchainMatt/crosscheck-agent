// Phase 4.1 lifecycle test.
//
// Proves that when the TS server is killed (SIGTERM) the Python child
// it spawned is reaped — no orphan Python processes per host crash.
//
// We do this end-to-end against the production dist bundle:
//   1. Spawn `node dist/node-stdio.js` with CROSSCHECK_BRIDGE_PYTHON=1
//   2. Run the MCP handshake so we KNOW the bridge child is alive
//   3. Parse the Python child PID from the "bridge online (pid=…)" line
//      the entrypoint writes to stderr
//   4. SIGTERM the TS parent
//   5. Poll `process.kill(pid, 0)` until ESRCH (or fail after 3 s)
//
// SKIPPED when python3 is unavailable OR when dist/ hasn't been built.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_SERVER = path.resolve(HERE, "..", "..", "..", "python", "crosscheck_server.py");
const TS_PKG = path.resolve(HERE, "..", "..");
const TS_ENTRY_DIST = path.resolve(TS_PKG, "dist", "node-stdio.js");

const PYTHON_AVAILABLE = (() => {
  if (!existsSync(PY_SERVER)) return false;
  return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
})();
const DIST_BUILT = existsSync(TS_ENTRY_DIST);

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but we can't signal it.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait until `pidIsAlive(pid)` is false, or until `timeoutMs` elapses.
 *  Returns whether the pid actually died within the window. */
async function awaitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidIsAlive(pid);
}

interface SpawnedBridge {
  parent:    ChildProcessWithoutNullStreams;
  childPid:  number;
}

/** Launch the dist entrypoint in bridge mode, complete enough of the
 *  MCP handshake that we know the Python child is fully alive, and
 *  return both the parent process handle and the parsed child PID. */
async function launchBridge(): Promise<SpawnedBridge> {
  const parent = spawn("node", [TS_ENTRY_DIST], {
    env: {
      ...process.env,
      CROSSCHECK_BRIDGE_PYTHON: "1",
      CROSSCHECK_PYTHON_SERVER:  PY_SERVER,
    } as NodeJS.ProcessEnv,
  });

  let stderrBuf = "";
  let stdoutBuf = "";
  let childPid: number | null = null;
  let initAcked = false;

  parent.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    if (childPid === null) {
      const m = stderrBuf.match(/bridge online \(pid=(\d+)\)/);
      if (m) childPid = Number(m[1]);
    }
  });
  parent.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    if (!initAcked && stdoutBuf.includes('"id":1')) initAcked = true;
  });

  // Send initialize. The entrypoint prints "bridge online (pid=N)" to
  // stderr BEFORE it starts serving MCP, so we'll have the PID by the
  // time the initialize ack lands.
  parent.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "0" },
      },
    }) + "\n",
  );

  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (childPid !== null && initAcked) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (childPid === null) {
    parent.kill("SIGKILL");
    throw new Error(`bridge never announced pid. stderr:\n${stderrBuf}`);
  }
  if (!initAcked) {
    parent.kill("SIGKILL");
    throw new Error(
      `bridge never acked initialize. stderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`,
    );
  }
  return { parent, childPid };
}

describe.skipIf(!PYTHON_AVAILABLE || !DIST_BUILT)(
  "bridge lifecycle (Phase 4.1)",
  () => {
    it("SIGTERM on the TS parent reaps the Python child", async () => {
      const { parent, childPid } = await launchBridge();
      // Sanity: the announced PID is live right now.
      expect(pidIsAlive(childPid)).toBe(true);

      parent.kill("SIGTERM");

      // Parent should also exit; we don't care about its exit code,
      // we only care that the grandchild died.
      const grandchildDied = await awaitPidExit(childPid, 3_000);

      // Don't leave anything running if the assertion fails.
      if (!grandchildDied && pidIsAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
      }
      if (parent.exitCode === null) parent.kill("SIGKILL");

      expect(grandchildDied).toBe(true);
    }, 15_000);

    it("stdin-close on the TS parent reaps the Python child", async () => {
      const { parent, childPid } = await launchBridge();
      expect(pidIsAlive(childPid)).toBe(true);

      // Gracefully close stdin — this is the host's normal "I'm done"
      // signal.
      parent.stdin.end();

      const grandchildDied = await awaitPidExit(childPid, 3_000);

      if (!grandchildDied && pidIsAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
      }
      if (parent.exitCode === null) parent.kill("SIGKILL");

      expect(grandchildDied).toBe(true);
    }, 15_000);
  },
);
