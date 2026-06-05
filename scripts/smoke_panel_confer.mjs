#!/usr/bin/env node
// Phase 5 smoke test: real end-to-end panel confer through native TS.
//
// What it does:
//   1. Spawn the dist bundle with provider env vars loaded from .env
//   2. Speak MCP JSON-RPC over stdin/stdout
//   3. Send initialize + tools/list + tools/call confer (real LLM call)
//   4. Pretty-print the panel responses and the timing/cost rollup
//
// This is the "panel confer at the end of the session" smoke test the
// user requested — it proves the full stack works end-to-end against
// live providers, not just byte-equal against canned fixtures.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "servers/typescript/dist/node-stdio.js");
const ENV_FILE = path.join(REPO, ".env");

if (!existsSync(DIST)) {
  console.error(`fatal: ${DIST} missing — run \`npm run build\` first`);
  process.exit(2);
}

// Load .env (no dependencies — naive parser).
function loadDotenv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const ln of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(ln.trim());
    if (m) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return out;
}
const dotenv = loadDotenv(ENV_FILE);
const env = { ...process.env, ...dotenv };

// Choose which providers to ask. Defaults to whatever's configured.
const wantProviders = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY",    "openai"],
  ["XAI_API_KEY",       "xai"],
  ["GEMINI_API_KEY",    "gemini"],
].filter(([k]) => Boolean(env[k])).map(([, n]) => n);

if (wantProviders.length === 0) {
  console.error("fatal: no provider API keys in env — set ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY / GEMINI_API_KEY");
  process.exit(2);
}

console.error(`smoke: panel = ${wantProviders.join(", ")}`);
console.error(`smoke: spawning ${DIST}\n`);

const child = spawn("node", [DIST], { env });

let stdoutBuf = "";
const responses = new Map();
let onResp = null;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === "object" && "id" in m) {
        responses.set(m.id, m);
        if (onResp) onResp(m);
      }
    } catch {}
  }
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server-stderr] ${chunk.toString("utf8")}`);
});
child.on("error", (e) => {
  console.error(`server spawn error: ${e}`);
  process.exit(1);
});

function send(id, method, params) {
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(id !== null ? { id } : {}) };
  child.stdin.write(JSON.stringify(msg) + "\n");
}
function waitFor(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (responses.has(id)) return resolve(responses.get(id));
    const t = setTimeout(() => { onResp = null; reject(new Error(`timeout waiting for id=${id} after ${timeoutMs}ms`)); }, timeoutMs);
    onResp = (m) => { if (m.id === id) { clearTimeout(t); onResp = null; resolve(m); } };
  });
}

(async () => {
  // 1. initialize
  send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-panel-confer", version: "0" },
  });
  const init = await waitFor(1, 10_000);
  console.error(`[init] server: ${init.result.serverInfo?.name} ${init.result.serverInfo?.version}`);

  // 2. notifications/initialized
  send(null, "notifications/initialized");

  // 3. tools/list — confirm `confer` is registered.
  send(2, "tools/list");
  const tools = await waitFor(2, 10_000);
  const names = (tools.result.tools ?? []).map((t) => t.name).sort();
  const haveConfer = names.includes("confer");
  console.error(`[tools/list] ${names.length} tools; confer present: ${haveConfer}`);
  if (!haveConfer) {
    console.error("fatal: confer not registered");
    child.kill();
    process.exit(1);
  }

  // 4. tools/call confer — real LLM call.
  const question = process.argv[2]
    ?? "What's the single most important property a TypeScript port of a Python LLM tool should preserve, and why?";
  console.error(`\n[confer] question: ${question}`);
  console.error(`[confer] dispatching to ${wantProviders.length} provider(s)...\n`);

  const t0 = Date.now();
  send(3, "tools/call", {
    name: "confer",
    arguments: {
      question,
      providers: wantProviders,
    },
  });
  // Generous timeout — LLM round-trips can be slow.
  const confer = await waitFor(3, 180_000);
  const elapsedMs = Date.now() - t0;

  if (confer.error) {
    console.error(`[confer] RPC error: ${JSON.stringify(confer.error)}`);
    child.kill();
    process.exit(1);
  }
  const text = confer.result?.content?.[0]?.text;
  const obj  = JSON.parse(text);

  console.error(`[confer] done in ${elapsedMs}ms (${(elapsedMs/1000).toFixed(1)}s wall)\n`);

  if (obj.error) {
    console.error(`[confer] tool error: ${obj.error}`);
    child.kill();
    process.exit(1);
  }

  const ans = obj.answers ?? [];
  console.log(`=== PANEL CONFER: ${ans.length} answers ===\n`);
  for (const a of ans) {
    const head = a.error
      ? `❌ ${a.provider} / ${a.model}  (${a.error_kind}): ${a.error}`
      : `✅ ${a.provider} / ${a.model}  [${a.usage?.total_tokens ?? 0} tok, $${(a.usage?.cost_usd ?? 0).toFixed(5)}]`;
    console.log(head);
    console.log("-".repeat(Math.min(70, head.length)));
    console.log((a.response ?? "(no response)").trim());
    console.log("");
  }

  if (ans.length === 0) {
    console.error("[confer] no answers returned — failure");
    child.kill();
    process.exit(1);
  }
  const errors = ans.filter((a) => a.error).length;
  console.error(`smoke: ${ans.length - errors}/${ans.length} providers returned successfully`);

  child.stdin.end();
  setTimeout(() => process.exit(errors === ans.length ? 1 : 0), 200);
})().catch((e) => {
  console.error(`smoke failed: ${e.message}`);
  child.kill();
  process.exit(1);
});
