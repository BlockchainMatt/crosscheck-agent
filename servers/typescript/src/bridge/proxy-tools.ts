// Plug a `BridgeHandle` into the TS server's tool registry as a set
// of proxy tools — one TS `Tool` entry per Python tool name. Each
// proxy's handler forwards to Python via `bridge.callTool()` and
// returns the response text verbatim.
//
// In route-all-to-Python mode this is the ENTIRE tool surface the TS
// server exposes — every call goes through. In per-tool routing mode
// (Phase 5+), proxies are added only for tools that have NOT yet been
// ported to TS; native tools dispatch their own handlers and the proxy
// list shrinks as PRs land.

import type { Tool } from "../tools/index.js";

import type { BridgeHandle } from "./python-bridge.js";

/** Build proxy Tool entries for every name in `bridge.toolNames`. The
 *  returned map can be merged into the TS server's tool registry. */
export function buildPythonProxies(bridge: BridgeHandle): Map<string, Tool> {
  const proxies = new Map<string, Tool>();
  for (const name of bridge.toolNames) {
    proxies.set(name, makeProxy(bridge, name));
  }
  return proxies;
}

function makeProxy(bridge: BridgeHandle, name: string): Tool {
  return {
    name,
    description: `(forwarded to Python crosscheck-agent) ${name}`,
    // We don't carry the per-tool input schema across the bridge in
    // route-all mode — the TS server is a transparent forwarder, so
    // arg validation happens on the Python side. inputSchema is left
    // permissive; the Python validator throws structured errors that
    // tunnel back through `callTool()`.
    inputSchema: {
      type: "object",
      additionalProperties: true,
      description: `Forwarded to Python — see Python tool '${name}' for full schema.`,
    },
    handler: async (args: Record<string, unknown>) => {
      const r = await bridge.callTool(name, args);
      // Python returns content: [{type:"text", text:"<json>"}]. We
      // parse the inner JSON and re-emit it as our tool's result. The
      // TS server's `handle()` re-stringifies (JSON.stringify) before
      // putting it back on the wire — so the round-trip preserves
      // semantic equality. Canonical-byte comparison happens at the
      // parity-test layer, which canonicalizes both sides before
      // diffing.
      if (!r.content.length) {
        return {};
      }
      const first = r.content[0]!;
      if (first.type === "text" && first.text) {
        try {
          return JSON.parse(first.text);
        } catch {
          // If the inner text isn't JSON (rare — only legacy tool
          // shapes do this), pass it through as a string under
          // `text` so downstream consumers still get the data.
          return { text: first.text };
        }
      }
      return { content: r.content };
    },
  };
}
