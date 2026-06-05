// Native-only behavior tests for runVerify. Cross-language parity is
// covered by `test/parity/verify.test.ts`; this file exercises:
//
//   1. The bridge-deferral path: when a check kind is shell or
//      url_head AND a bridge is supplied, the whole call is forwarded
//      to Python (verbatim).
//   2. The bridge-absent error paths for shell + url_head.
//   3. Native registry shadows the bridge proxy for `verify`.
//   4. pyStrRepr boundary cases that don't naturally appear in the
//      parity fixture but are part of the contract.

import { describe, expect, it } from "vitest";

import type { BridgeHandle } from "../../src/bridge/index.js";
import { registerCoreTools } from "../../src/tools/index.js";
import { runVerify } from "../../src/tools/verify.js";
import { pyListRepr, pyStrRepr } from "../../src/core/pyrepr.js";

/** Minimal in-memory BridgeHandle for testing the deferral path. */
function fakeBridge(opts: {
  toolNames?: string[];
  callTool?: (name: string, args: Record<string, unknown>) =>
    Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
} = {}): BridgeHandle {
  return {
    toolNames: new Set(opts.toolNames ?? ["verify", "list_providers"]),
    pid: 99999,
    callTool: opts.callTool ?? (async () => ({ content: [{ type: "text", text: "{}" }] })),
    refreshTools: async () => new Set(opts.toolNames ?? []),
    close: async () => { /* no-op */ },
  };
}

describe("runVerify — bridge deferral", () => {
  it("shell check with bridge → defers whole call to bridge", async () => {
    let captured: { name: string; args: Record<string, unknown> } | null = null;
    const bridge = fakeBridge({
      callTool: async (name, args) => {
        captured = { name, args };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              tool: "verify", checks_run: 1,
              results: [{ id: "s1", kind: "shell", passed: true,
                          exit_code: 0, reason: "ok" }],
              all_passed: true, summary: "1 of 1 checks passed",
            }),
          }],
        };
      },
    });
    const r = await runVerify(
      { allow_shell: true, checks: [{ kind: "shell", id: "s1", cmd: "true" }] },
      bridge,
    );
    expect(captured).not.toBeNull();
    expect(captured!.name).toBe("verify");
    expect(captured!.args["allow_shell"]).toBe(true);
    expect((r as { all_passed: boolean }).all_passed).toBe(true);
  });

  it("url_head check with bridge → defers whole call to bridge", async () => {
    let deferred = false;
    const bridge = fakeBridge({
      callTool: async () => {
        deferred = true;
        return { content: [{ type: "text", text: '{"tool":"verify","checks_run":0,"results":[],"all_passed":false,"summary":"0 of 0 checks passed"}' }] };
      },
    });
    await runVerify(
      { checks: [{ kind: "url_head", url: "https://example.com" }] },
      bridge,
    );
    expect(deferred).toBe(true);
  });

  it("shell check WITHOUT bridge + allow_shell=false → 'shell disabled' reason (Python parity)", async () => {
    const r = await runVerify(
      { checks: [{ kind: "shell", id: "s1", cmd: "true" }] },
      undefined,
    ) as { results: { reason: string; passed: boolean }[] };
    expect(r.results[0]!.passed).toBe(false);
    expect(r.results[0]!.reason).toBe(
      "shell checks disabled; pass `allow_shell:true` to opt in",
    );
  });

  it("shell check WITHOUT bridge + allow_shell=true → 'requires bridge mode' reason", async () => {
    const r = await runVerify(
      { allow_shell: true, checks: [{ kind: "shell", id: "s1", cmd: "true" }] },
      undefined,
    ) as { results: { reason: string; passed: boolean }[] };
    expect(r.results[0]!.passed).toBe(false);
    expect(r.results[0]!.reason).toContain("require bridge mode");
  });

  it("url_head WITHOUT bridge → 'requires bridge mode' reason", async () => {
    const r = await runVerify(
      { checks: [{ kind: "url_head", id: "u1", url: "https://example.com" }] },
      undefined,
    ) as { results: { reason: string; passed: boolean }[] };
    expect(r.results[0]!.passed).toBe(false);
    expect(r.results[0]!.reason).toContain("require bridge mode");
  });

  it("bridge returns garbage envelope → returns clear error", async () => {
    const bridge = fakeBridge({
      callTool: async () => ({ content: [{ type: "text", text: "not-json" }] }),
    });
    const r = await runVerify(
      { checks: [{ kind: "shell", cmd: "x" }] },
      bridge,
    ) as { error_code?: string };
    expect(r.error_code).toBe("VERIFY_BRIDGE_BAD_ENVELOPE");
  });
});

describe("native registry — verify shadows bridge proxy", () => {
  it("registerCoreTools(undefined) registers `verify` natively (no bridge needed)", () => {
    const tools = registerCoreTools(undefined);
    expect(tools.has("verify")).toBe(true);
    expect(tools.has("ping")).toBe(true);
  });

  it("registerCoreTools(bridge) still registers native verify; the buildToolRegistry merge keeps native winning", () => {
    const tools = registerCoreTools(fakeBridge());
    const verifyEntry = tools.get("verify");
    expect(verifyEntry).toBeDefined();
    // Sanity: the native handler is the runVerify function, not a
    // proxy. Easiest proof: a bare {checks:[]} call returns the
    // native error envelope synchronously (proxy would round-trip).
    return verifyEntry!.handler({ checks: [] }).then((r) => {
      expect((r as { error_code: string }).error_code).toBe("VERIFY_MISSING_CHECKS");
    });
  });
});

describe("pyrepr helpers — boundary cases", () => {
  it("single-quoted strings use double-quote outer when content has '", () => {
    expect(pyStrRepr("can't")).toBe("\"can't\"");
  });

  it("escapes embedded newline / tab / control char", () => {
    expect(pyStrRepr("a\nb")).toBe("'a\\nb'");
    expect(pyStrRepr("a\tb")).toBe("'a\\tb'");
    expect(pyStrRepr("a\x07b")).toBe("'a\\x07b'");
  });

  it("escapes the chosen quote", () => {
    expect(pyStrRepr("o'reilly \"quoted\"")).toBe("'o\\'reilly \"quoted\"'");
  });

  it("non-ASCII printable Unicode is emitted verbatim (Python 3 repr)", () => {
    expect(pyStrRepr("naïve")).toBe("'naïve'");
  });

  it("pyListRepr emits Python str(list) format", () => {
    expect(pyListRepr(["a", "b'c", "d"])).toBe("['a', \"b'c\", 'd']");
    expect(pyListRepr([])).toBe("[]");
  });
});
