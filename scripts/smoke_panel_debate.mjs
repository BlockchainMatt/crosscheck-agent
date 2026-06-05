#!/usr/bin/env node
// Phase 5 smoke test: real end-to-end panel DEBATE through native TS.
//
// Similar to smoke_panel_confer.mjs but exercises the multi-round
// dispatch + moderator synthesis path. Validates that native debate
// works through the full MCP stdio wire with live providers.

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

const wantProviders = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY",    "openai"],
  ["XAI_API_KEY",       "xai"],
  ["GEMINI_API_KEY",    "gemini"],
].filter(([k]) => Boolean(env[k])).map(([, n]) => n);

if (wantProviders.length < 2) {
  console.error("fatal: debate needs at least 2 providers with keys");
  process.exit(2);
}

const TOPIC = process.argv[2]
  ?? "Should a Python→TS port preserve API ergonomics (snake_case fields, etc.) or adapt to TS conventions (camelCase)? Argue your side in <120 words.";
const MAX_ROUNDS = Number(process.env["MAX_ROUNDS"] ?? 2);
const MODERATOR = process.env["MODERATOR"] ?? "anthropic";

console.error(`smoke: panel = ${wantProviders.join(", ")}`);
console.error(`smoke: rounds = ${MAX_ROUNDS}, moderator = ${MODERATOR}`);
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

(async () => {
  send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-panel-debate", version: "0" },
  });
  await waitFor(1, 10_000);
  send(null, "notifications/initialized");

  send(2, "tools/list");
  const tools = await waitFor(2, 10_000);
  const names = (tools.result.tools ?? []).map((t) => t.name).sort();
  const haveDebate = names.includes("debate");
  console.error(`[tools/list] ${names.length} tools; debate present: ${haveDebate}`);
  if (!haveDebate) {
    console.error("fatal: debate not registered");
    child.kill();
    process.exit(1);
  }

  console.error(`\n[debate] topic: ${TOPIC}`);
  console.error(`[debate] dispatching ${MAX_ROUNDS} round(s) × ${wantProviders.length} provider(s) + synthesis (~${MAX_ROUNDS * wantProviders.length + 1} LLM calls)...\n`);

  const t0 = Date.now();
  send(3, "tools/call", {
    name: "debate",
    arguments: {
      topic: TOPIC,
      providers: wantProviders,
      max_rounds: MAX_ROUNDS,
      moderator: MODERATOR,
    },
  });
  // Multi-round + synthesis can take a while.
  const result = await waitFor(3, 300_000);
  const elapsedMs = Date.now() - t0;

  if (result.error) {
    console.error(`[debate] RPC error: ${JSON.stringify(result.error)}`);
    child.kill();
    process.exit(1);
  }
  const text = result.result?.content?.[0]?.text;
  const obj  = JSON.parse(text);

  console.error(`[debate] done in ${elapsedMs}ms (${(elapsedMs/1000).toFixed(1)}s wall)\n`);

  if (obj.error) {
    console.error(`[debate] tool error: ${obj.error}`);
    child.kill();
    process.exit(1);
  }

  // Print transcript grouped by round.
  const transcript = obj.transcript ?? [];
  const synthesis  = obj.synthesis ?? null;
  const roundsCompleted = obj.rounds_completed ?? 0;

  console.log(`=== PANEL DEBATE: ${roundsCompleted} round(s), ${transcript.length} turn(s) ===\n`);
  for (let rnd = 1; rnd <= roundsCompleted; rnd++) {
    console.log(`### ROUND ${rnd} ###\n`);
    for (const e of transcript) {
      if (e.round !== rnd) continue;
      const head = e.error
        ? `❌ ${e.provider} / ${e.model}  (${e.error_kind}): ${e.error}`
        : `✅ ${e.provider} / ${e.model}  [${e.usage?.total_tokens ?? 0} tok, $${(e.usage?.cost_usd ?? 0).toFixed(5)}]`;
      console.log(head);
      console.log("-".repeat(Math.min(70, head.length)));
      console.log((e.response ?? "(no response)").trim());
      console.log("");
    }
  }

  console.log(`### MODERATOR SYNTHESIS ###\n`);
  if (!synthesis) {
    console.log("(no synthesis returned)\n");
  } else {
    const head = synthesis.error
      ? `❌ ${synthesis.provider} / ${synthesis.model}  (${synthesis.error_kind}): ${synthesis.error}`
      : `✅ ${synthesis.provider} / ${synthesis.model}  [${synthesis.usage?.total_tokens ?? 0} tok, $${(synthesis.usage?.cost_usd ?? 0).toFixed(5)}]`;
    console.log(head);
    console.log("-".repeat(Math.min(70, head.length)));
    console.log((synthesis.response ?? "(no response)").trim());
    console.log("");
  }

  // Totals.
  let totalTokens = 0, totalCost = 0;
  for (const e of transcript) {
    totalTokens += e.usage?.total_tokens ?? 0;
    totalCost   += e.usage?.cost_usd     ?? 0;
  }
  if (synthesis && !synthesis.error) {
    totalTokens += synthesis.usage?.total_tokens ?? 0;
    totalCost   += synthesis.usage?.cost_usd     ?? 0;
  }
  console.error(`\nsmoke: total ${totalTokens} tokens, $${totalCost.toFixed(5)} across ${transcript.length + (synthesis ? 1 : 0)} call(s)`);

  child.stdin.end();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error(`smoke failed: ${e.message}`);
  child.kill();
  process.exit(1);
});
