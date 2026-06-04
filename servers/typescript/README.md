# @crosscheck/server (TypeScript port — phase 0)

The Python implementation in [../python/crosscheck_server.py](../python/crosscheck_server.py)
is the canonical source of truth. This TypeScript package is the in-progress
port. **Do not use this in production yet.** Use the Python server.

## Phase 0 status

Bootstrap only. The MCP wire is alive over stdio; one tool (`ping`)
is registered to prove the handshake works.

What's here:

- Modular source layout under `src/{core,tools,providers,adapters/*,entrypoints}/`.
  Each directory will be populated phase by phase.
- `src/server.ts` — transport-agnostic MCP server.
- `src/entrypoints/node-stdio.ts` — Node stdio entrypoint (working).
- `src/entrypoints/{node-http,browser-ext}.ts` — stubs that will host
  Streamable HTTP and browser-extension transports in later phases.
- `src/tools/index.ts` — tool registry with a `defineTool()` helper. Phase 0
  registers a single `ping` tool.
- `tsup.config.ts` — builds three single-file bundles per target (`node-stdio`,
  `node-http`, `browser-ext`) in both ESM and CJS.
- `test/unit/ping.test.ts` — vitest unit tests.

Verified end-to-end: `initialize` → `tools/list` → `tools/call ping` over
JSON-RPC stdio returns the expected envelopes.

## Quick start (dev)

```bash
cd servers/typescript
npm install
npm run build        # tsup → dist/{node-stdio,node-http,browser-ext}.{js,cjs}
npm test             # vitest
```

End-to-end stdio handshake:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{"echo":"hello"}}}' \
  | node dist/node-stdio.js
```

## Migration plan

The full port follows the phased plan agreed on by the multi-LLM panel
(confer + debate + plan, session `ts-port-design-1`). See the project
root README for the high-level shape; subsequent phase PRs land here.

Architectural decisions locked at phase 0 (won't change without a new debate):

- Modular author-time tree → single bundled file per target at ship time.
- Storage interface = typed method-per-query (~30 methods) + `recallSearch()`
  encapsulating FTS5 + async-only + `txn(fn)` callback + shipped migration list.
- Node-first; browser support via `wa-sqlite + OPFS` adapter; Deno/Bun ignored.
- Minimal deps: `@modelcontextprotocol/sdk`, `zod` (Phase 0); `better-sqlite3`,
  `wa-sqlite`, `eventsource-parser` land in later phases.
- Raw `fetch` for LLM providers — no provider SDKs.
- Migration = tool-by-tool with a Python↔TS MCP-over-MCP bridge; Python remains
  the oracle until byte-equal parity is proven across 38 ported test scripts
  for 7 consecutive days and zero fallbacks for 2 weeks.

## License

Same as the project root — [PolyForm Noncommercial 1.0.0](../../LICENSE).
Commercial licenses are listed in [../../COMMERCIAL-LICENSES.md](../../COMMERCIAL-LICENSES.md).
