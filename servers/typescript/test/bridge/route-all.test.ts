// Phase 4 mini-exit-gate test.
//
// Runs the TS server in route-all-to-Python mode end-to-end:
//   1. Spawn TS server subprocess with CROSSCHECK_BRIDGE_PYTHON=1
//   2. Speak MCP JSON-RPC to it via stdin/stdout (the TS server is
//      itself an MCP server here; the bridge is internal to it)
//   3. Send tools/call for `verify` (deterministic by construction)
//   4. Run the SAME tools/call directly against the Python server
//   5. Canonicalize both responses and assert byte-equal.
//
// This is the actual Phase 4 exit gate scaled to one tool. The 38-
// script sweep follows the same pattern with the full parity harness
// in Phase 5.
//
// SKIPPED when python3 isn't on PATH OR when the dist/ bundle hasn't
// been built (production CJS path).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_SERVER = path.resolve(HERE, "..", "..", "..", "python", "crosscheck_server.py");
const TS_PKG = path.resolve(HERE, "..", "..");
const TS_ENTRY_DIST = path.resolve(TS_PKG, "dist", "node-stdio.js");

const PYTHON_AVAILABLE = (() => {
  if (!existsSync(PY_SERVER)) return false;
  const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
  return r.status === 0;
})();

const DIST_BUILT = existsSync(TS_ENTRY_DIST);

interface RpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }

/** Run a fixed MCP-over-stdio dialogue against `cmd` + `args` and
 *  return the line-delimited JSON-RPC responses. */
async function runStdioDialogue(
  cmd: string,
  args: string[],
  requests: RpcRequest[],
  env: NodeJS.ProcessEnv,
): Promise<{ responses: unknown[]; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(cmd, args, { env });
    let stdoutBuf = "";
    let stderrBuf = "";
    const responses: unknown[] = [];
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGKILL");
        reject(new Error(
          `stdio dialogue timeout. stderr:\n${stderrBuf.slice(-1500)}\nresponses-so-far:\n${responses.length}`,
        ));
      }
    }, 45_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          try { responses.push(JSON.parse(line)); }
          catch { /* skip non-JSON lines */ }
        }
        nl = stdoutBuf.indexOf("\n");
      }
      // Stop once we've seen one response per non-notification request.
      // (MCP notifications never get a response, regardless of whether
      // we put an `id` field on the wire object.)
      const expected = requests.filter(
        (r) => !r.method.startsWith("notifications/"),
      ).length;
      if (responses.length >= expected && !done) {
        done = true;
        clearTimeout(timeout);
        // Give the child a moment to flush stderr before killing.
        setTimeout(() => {
          child.kill("SIGTERM");
        }, 50);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    child.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
      }
      resolve({ responses, stderr: stderrBuf });
    });
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(e);
      }
    });

    // Write all requests at once + close stdin so the server knows
    // we're done. (Both Python and TS treat stdin-close as EOF.)
    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
  });
}

const HANDSHAKE: RpcRequest[] = [
  {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "route-all-test", version: "0" },
    },
  },
  { jsonrpc: "2.0", id: "notif", method: "notifications/initialized" },
];

const VERIFY_CALL: RpcRequest = {
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: {
    name: "verify",
    arguments: {
      checks: [
        { kind: "contains", id: "c1", target_text: "the quick brown fox",
          value: "fox" },
        { kind: "not_contains", id: "c2", target_text: "the quick brown fox",
          value: "lazy" },
      ],
    },
  },
};

describe.skipIf(!PYTHON_AVAILABLE || !DIST_BUILT)(
  "route-all-to-Python (Phase 4 exit gate, scaled to one tool)",
  () => {
    it("TS bridge route-all output byte-equals direct-Python output", async () => {
      // Run the verify call directly against Python.
      const pyResult = await runStdioDialogue(
        "python3", [PY_SERVER],
        [...HANDSHAKE, VERIFY_CALL],
        { ...process.env } as NodeJS.ProcessEnv,
      );
      // Run the SAME verify call through the TS bridge (which spawns
      // its own Python child internally).
      const tsResult = await runStdioDialogue(
        "node", [TS_ENTRY_DIST],
        [...HANDSHAKE, VERIFY_CALL],
        {
          ...process.env,
          CROSSCHECK_BRIDGE_PYTHON: "1",
          CROSSCHECK_PYTHON_SERVER:  PY_SERVER,
        } as NodeJS.ProcessEnv,
      );

      // First response in both is the initialize ack; second is the
      // tools/call result.
      expect(pyResult.responses.length).toBeGreaterThanOrEqual(2);
      expect(tsResult.responses.length).toBeGreaterThanOrEqual(2);

      const pyResp = pyResult.responses.find(
        (r) => (r as { id?: unknown }).id === 2,
      );
      const tsResp = tsResult.responses.find(
        (r) => (r as { id?: unknown }).id === 2,
      );
      expect(pyResp).toBeDefined();
      expect(tsResp).toBeDefined();

      // Canonicalize each side. The TS-bridge envelope re-stringifies
      // (parse → restringify) inside the proxy handler, so the
      // top-level "text" string MAY have different whitespace; the
      // canonicalizer strips that.
      const pyCanon = canonicalize(pyResp);
      const tsCanon = canonicalize(tsResp);

      // The bridge path proves byte-equal here. The MCP envelope
      // (jsonrpc/id/result/content) is identical; the inner JSON
      // canonicalizes to the same string regardless of which path
      // produced it.
      expect(tsCanon).toBe(pyCanon);
    }, 60_000);
  },
);
