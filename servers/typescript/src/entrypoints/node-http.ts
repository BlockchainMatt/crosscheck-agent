// Node-HTTP entrypoint — stub. Will host the MCP Streamable HTTP transport
// (added in a later phase). Lives here so tsup builds a bundle slot for it
// from day one, and so the import surface in `dist/` is stable.

export const PLACEHOLDER = "node-http transport — not yet implemented";

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stderr.write(
    "crosscheck-agent: node-http entrypoint is not yet implemented (Phase 0).\n",
  );
  process.exit(2);
}
