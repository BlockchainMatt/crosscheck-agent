#!/usr/bin/env node
// Phase 5 full-stack smoke: validates the native LLM + native storage
// paths end-to-end through the production dist bundle.
//
// 1. Spawn the dist bundle with .env loaded (providers) + a temp DB
// 2. tools/list — confirms storage + LLM tools all registered
// 3. tools/call confer — real LLM panel (4 providers)
// 4. tools/call session_memory action=add — native storage write
// 5. tools/call session_memory action=list — native storage read
// 6. tools/call scoreboard — native multi-table aggregate
// 7. Print cost + token totals
// 8. Cleanly shut down

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "servers/typescript/dist/node-stdio.js");
const ENV_FILE = path.join(REPO, ".env");

if (!existsSync(DIST)) {
  console.error(`fatal: ${DIST} missing — run \`npm run build\` first`);
  process.exit(2);
}

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
const wantProviders = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY",    "openai"],
  ["XAI_API_KEY",       "xai"],
  ["GEMINI_API_KEY",    "gemini"],
].filter(([k]) => Boolean(dotenv[k] ?? process.env[k])).map(([, n]) => n);

if (wantProviders.length < 1) {
  console.error("fatal: no provider API keys in env");
  process.exit(2);
}

const tmpDir = mkdtempSync(path.join(tmpdir(), "crosscheck-smoke-"));
const dbPath = path.join(tmpDir, "smoke-db.sqlite");

const env = {
  ...process.env, ...dotenv,
  CROSSCHECK_DB_PATH: dbPath,
};

console.error(`smoke: panel = ${wantProviders.join(", ")}`);
console.error(`smoke: db    = ${dbPath}`);
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
  const msg = { jsonrpc: "2.0", method,
                ...(params ? { params } : {}),
                ...(id !== null ? { id } : {}) };
  child.stdin.write(JSON.stringify(msg) + "\n");
}
function waitFor(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (responses.has(id)) return resolve(responses.get(id));
    const t = setTimeout(() => {
      onResp = null;
      reject(new Error(`timeout waiting for id=${id} after ${timeoutMs}ms`));
    }, timeoutMs);
    onResp = (m) => {
      if (m.id === id) { clearTimeout(t); onResp = null; resolve(m); }
    };
  });
}

function unwrapResult(rpc) {
  if (rpc.error) throw new Error(`RPC error: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

(async () => {
  send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-full-stack", version: "0" },
  });
  await waitFor(1, 10_000);
  send(null, "notifications/initialized");

  // === tools/list ===
  send(2, "tools/list");
  const tools = (await waitFor(2, 10_000)).result.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  console.error(`\n[tools/list] ${names.length} tools registered:`);
  console.error(`  ${names.join(", ")}\n`);
  const expectedNative = ["confer", "debate", "audit", "verify", "pick",
                          "recall", "session_memory", "scoreboard", "explain"];
  for (const n of expectedNative) {
    if (!names.includes(n)) {
      console.error(`fatal: ${n} not registered`);
      child.kill(); process.exit(1);
    }
  }

  // === confer panel (live LLM calls) ===
  console.error("[confer] dispatching live panel...");
  const t0 = Date.now();
  send(3, "tools/call", {
    name: "confer",
    arguments: {
      question: "In one sentence, what's the biggest risk when porting a Python LLM tool to TypeScript?",
      providers: wantProviders,
    },
  });
  const conferRpc = await waitFor(3, 180_000);
  const conferElapsedMs = Date.now() - t0;
  const conferOut = unwrapResult(conferRpc);
  if (conferOut.error) {
    console.error(`[confer] tool error: ${conferOut.error}`);
    child.kill(); process.exit(1);
  }

  // Tally cost + tokens.
  let totalTokens = 0, totalCost = 0;
  for (const a of conferOut.answers ?? []) {
    totalTokens += a.usage?.total_tokens ?? 0;
    totalCost   += a.usage?.cost_usd     ?? 0;
  }
  console.log(`\n=== CONFER PANEL (${(conferElapsedMs/1000).toFixed(1)}s, $${totalCost.toFixed(5)}, ${totalTokens} tok) ===\n`);
  for (const a of conferOut.answers ?? []) {
    const head = a.error
      ? `❌ ${a.provider} / ${a.model}: ${a.error}`
      : `✅ ${a.provider} / ${a.model}  [${a.usage?.total_tokens ?? 0} tok, $${(a.usage?.cost_usd ?? 0).toFixed(5)}]`;
    console.log(head);
    console.log((a.response ?? "").trim());
    console.log("");
  }

  // === session_memory: add 2 rows ===
  const sid = "smoke-test-session";
  console.error("[session_memory] add (1/2)...");
  send(4, "tools/call", {
    name: "session_memory",
    arguments: {
      action: "add", session_id: sid, kind: "fact",
      content: "panel converged on prompt-fidelity as the headline risk",
      source_tool: "confer",
    },
  });
  const sm1 = unwrapResult(await waitFor(4, 10_000));
  console.log(`[session_memory] add → id=${sm1.id}\n`);

  console.error("[session_memory] add (2/2)...");
  send(5, "tools/call", {
    name: "session_memory",
    arguments: {
      action: "add", session_id: sid, kind: "open_question",
      content: "do we need byte-equal output for live LLM calls too?",
    },
  });
  const sm2 = unwrapResult(await waitFor(5, 10_000));
  console.log(`[session_memory] add → id=${sm2.id}\n`);

  // === session_memory: list ===
  console.error("[session_memory] list...");
  send(6, "tools/call", {
    name: "session_memory",
    arguments: { action: "list", session_id: sid },
  });
  const smList = unwrapResult(await waitFor(6, 10_000));
  console.log(`[session_memory] list → ${smList.count} row(s):`);
  for (const row of smList.rows) {
    console.log(`  [${row.kind}] ${row.content}`);
  }
  console.log("");

  // === scoreboard ===
  console.error("[scoreboard] aggregate query...");
  send(7, "tools/call", { name: "scoreboard", arguments: {} });
  const sb = unwrapResult(await waitFor(7, 10_000));
  console.log(`[scoreboard] providers: ${sb.providers.length}, totals: ${JSON.stringify(sb.totals)}\n`);

  console.error(`\n=== SMOKE COMPLETE ===`);
  console.error(`Cost:        $${totalCost.toFixed(5)} across ${conferOut.answers.length} provider(s)`);
  console.error(`Tokens:      ${totalTokens}`);
  console.error(`Wall time:   ${(conferElapsedMs/1000).toFixed(1)}s (confer alone)`);
  console.error(`Storage ops: 4 successful (2 adds + 1 list + 1 scoreboard)`);

  child.stdin.end();
  setTimeout(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  }, 200);
})().catch((e) => {
  console.error(`smoke failed: ${e.message}`);
  child.kill();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
