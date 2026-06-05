#!/usr/bin/env node
// diff-output.ts — line-by-line canonical-diff for two JSONL files.
//
// Usage:
//   node --import tsx scripts/diff-output.ts <left.jsonl> <right.jsonl>
//   tsx scripts/diff-output.ts <left.jsonl> <right.jsonl>
//
// Both files are read line-by-line; each line is JSON.parsed, run through
// the canonicalizer, then byte-compared. Exits 0 if every line matches,
// 1 if any line diverges (printing the first divergence), 2 on usage / I/O
// error.
//
// This is the parity-gate engine used by every later phase's CI.

import { readFile } from "node:fs/promises";

import { canonicalize } from "../src/core/canonicalize.js";

interface Args {
  left: string;
  right: string;
  precision?: number;
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let precision: number | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--precision" || a === "-p") {
      const v = argv[++i];
      if (!v) return null;
      precision = Number(v);
    } else if (a.startsWith("--precision=")) {
      precision = Number(a.split("=", 2)[1]);
    } else if (a === "--help" || a === "-h") {
      return null;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return null;
  return {
    left: positional[0]!,
    right: positional[1]!,
    ...(precision !== undefined ? { precision } : {}),
  };
}

function usage(): never {
  process.stderr.write(
    "usage: diff-output.ts [--precision N] <left.jsonl> <right.jsonl>\n",
  );
  process.exit(2);
}

async function readLines(path: string): Promise<string[]> {
  const txt = await readFile(path, "utf8");
  // Trim a trailing newline so we don't compare an empty "line" at EOF.
  return txt.replace(/\n$/, "").split("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args) usage();
  const opts = args.precision !== undefined ? { floatPrecision: args.precision } : undefined;

  const [leftLines, rightLines] = await Promise.all([
    readLines(args.left),
    readLines(args.right),
  ]);

  const n = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < n; i++) {
    const L = leftLines[i] ?? "";
    const R = rightLines[i] ?? "";
    // Empty line at EOF -> treat as match.
    if (L === "" && R === "") continue;
    const lc = canonicalize(safeParse(L), opts);
    const rc = canonicalize(safeParse(R), opts);
    if (lc !== rc) {
      process.stderr.write(`diff at line ${i + 1}:\n`);
      process.stderr.write(`  left : ${lc}\n`);
      process.stderr.write(`  right: ${rc}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`OK: ${n} line(s) byte-equal after canonicalization\n`);
}

function safeParse(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // If a line isn't valid JSON, compare the raw text. Useful for log
    // lines mixed into the stream.
    return s;
  }
}

main().catch((err) => {
  process.stderr.write(`diff-output: fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(2);
});
