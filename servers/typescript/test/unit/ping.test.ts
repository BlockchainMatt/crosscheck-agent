// Phase-0 smoke test: prove the server boots, registers the ping tool,
// and that the handler returns the expected envelope. This is the
// minimum bar for "the TS wire is alive."

import { describe, expect, it } from "vitest";

import { createServer, SERVER_NAME, SERVER_VERSION } from "../../src/server.js";
import { registerCoreTools } from "../../src/tools/index.js";

describe("server bootstrap", () => {
  it("createServer() returns an MCP Server instance without throwing", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });
});

describe("ping tool", () => {
  it("is registered by registerCoreTools()", () => {
    const tools = registerCoreTools();
    expect(tools.has("ping")).toBe(true);
  });

  it("has an inputSchema with no required fields", () => {
    const tools = registerCoreTools();
    const ping = tools.get("ping");
    expect(ping).toBeDefined();
    const schema = ping!.inputSchema as { type: string; required?: string[] };
    expect(schema.type).toBe("object");
    expect(schema.required).toBeUndefined();
  });

  it("echoes the caller-supplied string, defaulting to 'pong'", async () => {
    const tools = registerCoreTools();
    const ping = tools.get("ping")!;

    const a = (await ping.handler({})) as Record<string, unknown>;
    expect(a).toMatchObject({
      tool: "ping",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      pong: "pong",
    });

    const b = (await ping.handler({ echo: "hello" })) as Record<string, unknown>;
    expect(b.pong).toBe("hello");
  });

  it("rejects an echo value that isn't a string", async () => {
    const tools = registerCoreTools();
    const ping = tools.get("ping")!;
    // Zod-driven validation must reject — we don't want loose typing
    // bleeding into per-tool handlers.
    await expect(ping.handler({ echo: 42 } as unknown as Record<string, unknown>))
      .rejects.toThrow(/validation/i);
  });
});
