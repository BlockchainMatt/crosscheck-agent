// End-to-end test for the Python↔TS bridge.
//
// Spawns the real Python crosscheck-agent as an MCP stdio child via
// the same `spawnPythonBridge()` helper the production entrypoint
// uses. Calls deterministic-by-construction tools (`list_providers`,
// `verify`) and asserts the response shape.
//
// SKIPPED when `python3` isn't on PATH (e.g. CI shards without Python)
// so this test never breaks pure-TS development.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type BridgeHandle, spawnPythonBridge } from "../../src/bridge/index.js";

// Resolve the Python server path relative to this test file's location:
// servers/typescript/test/bridge/ → servers/python/crosscheck_server.py
const PY_SERVER = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "python", "crosscheck_server.py");
})();

const PY_AVAILABLE = (() => {
  if (!existsSync(PY_SERVER)) return false;
  const r = spawnSync("python3", ["--version"], { stdio: "ignore" });
  return r.status === 0;
})();

describe.skipIf(!PY_AVAILABLE)("Python bridge (end-to-end)", () => {
  let bridge: BridgeHandle;

  beforeAll(async () => {
    bridge = await spawnPythonBridge({
      serverPath: PY_SERVER,
      initTimeoutMs: 30_000,
    });
  }, 35_000);

  afterAll(async () => {
    if (bridge) await bridge.close();
  });

  it("handshake exposes the full Python tool surface", () => {
    expect(bridge.toolNames.size).toBeGreaterThan(15);
    // Spot-check a handful of expected tools.
    for (const name of [
      "list_providers", "verify", "explain", "recall", "session_memory",
      "scoreboard", "confer", "debate", "coordinate",
    ]) {
      expect(bridge.toolNames.has(name)).toBe(true);
    }
  });

  it("list_providers returns a structured envelope", async () => {
    const r = await bridge.callTool("list_providers", {});
    expect(r.content.length).toBeGreaterThan(0);
    const text = r.content[0]!.text;
    const parsed = JSON.parse(text);
    // Python's list_providers payload is `{providers: [...]}` (no
    // `tool` field — that's only added on tools that emit one).
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(parsed.providers.length).toBeGreaterThan(0);
    expect(typeof parsed.providers[0].name).toBe("string");
  });

  it("verify with contains-check returns all_passed:true", async () => {
    const r = await bridge.callTool("verify", {
      checks: [
        { kind: "contains", id: "c1", target_text: "hello world", value: "hello" },
      ],
    });
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.tool).toBe("verify");
    expect(parsed.all_passed).toBe(true);
    expect(parsed.checks_run).toBe(1);
  });

  it("verify with failing check returns all_passed:false", async () => {
    const r = await bridge.callTool("verify", {
      checks: [
        { kind: "contains", id: "c1", target_text: "hello", value: "goodbye" },
      ],
    });
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.all_passed).toBe(false);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].passed).toBe(false);
  });
});
