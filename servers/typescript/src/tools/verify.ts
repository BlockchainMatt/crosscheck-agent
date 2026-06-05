// Native TS port of Python's `tool_verify` — Phase 5 part 1.
//
// Surface (matches Python tool_verify in crosscheck_server.py):
//   Input:
//     checks:       required non-empty list of {kind, id?, ...}
//     session_id:   optional (used by run_summary; not consumed here)
//     allow_shell:  optional, default false
//   Check kinds:
//     contains | not_contains | regex_match
//     contains_any | contains_all | min_length
//       → handled NATIVELY here (byte-equal with Python's _eval_verifier)
//     shell | url_head
//       → handled via the bridge when available; otherwise returns a
//         clear error so callers know they need bridge mode. This keeps
//         the native port lean and preserves byte-equal behavior for
//         the advanced kinds.
//
// Output shape mirrors Python exactly EXCEPT:
//   - `timing` is included but contains real wall_ms/cpu_ms numbers
//     (non-deterministic — stripped by parity tests).
//   - `run_summary` is OMITTED in the native path. Python wraps it in
//     try/except so absence is a valid Python output too. We'll re-port
//     run_summary when session_memory lands.
//
// All check execution is pure compute. No I/O hidden inside.

import { performance } from "node:perf_hooks";

import type { BridgeHandle } from "../bridge/index.js";
import { pyListRepr, pyStrRepr } from "../core/pyrepr.js";

/** Tuple {passed, label} from a single text-kind check. */
interface EvalResult { passed: boolean; label: string }

/** Mirror of Python's `_VERIFY_TEXT_KINDS` (literal order matters for
 *  no human-visible reason, but kept identical so future audits diff
 *  cleanly). */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  "contains", "not_contains", "regex_match",
  "contains_any", "contains_all", "min_length",
]);

/** Run one text-kind check. Direct port of Python `_eval_verifier`. */
function evalVerifier(spec: Record<string, unknown>, text: string): EvalResult {
  const kind = spec["kind"];
  const ci   = Boolean(spec["case_insensitive"]);

  if (kind === "contains") {
    const v = String(spec["value"] ?? "");
    if (ci) {
      return { passed: text.toLowerCase().includes(v.toLowerCase()),
               label: `contains[ci] ${pyStrRepr(v)}` };
    }
    return { passed: text.includes(v), label: `contains ${pyStrRepr(v)}` };
  }
  if (kind === "not_contains") {
    const v = String(spec["value"] ?? "");
    if (ci) {
      return { passed: !text.toLowerCase().includes(v.toLowerCase()),
               label: `not_contains[ci] ${pyStrRepr(v)}` };
    }
    return { passed: !text.includes(v), label: `not_contains ${pyStrRepr(v)}` };
  }
  if (kind === "regex_match") {
    const pat = String(spec["value"] ?? "");
    let re: RegExp;
    try {
      re = new RegExp(pat, ci ? "i" : "");
    } catch (e) {
      return { passed: false, label: `regex_match[bad pattern: ${(e as Error).message}]` };
    }
    return { passed: re.test(text), label: `regex_match ${pyStrRepr(pat)}` };
  }
  if (kind === "contains_any") {
    const vs = toStringList(spec["values"]);
    const ok = ci
      ? vs.some((v) => text.toLowerCase().includes(v.toLowerCase()))
      : vs.some((v) => text.includes(v));
    return { passed: ok, label: `contains_any ${pyListRepr(vs)}` };
  }
  if (kind === "contains_all") {
    const vs = toStringList(spec["values"]);
    const ok = ci
      ? vs.every((v) => text.toLowerCase().includes(v.toLowerCase()))
      : vs.every((v) => text.includes(v));
    return { passed: ok, label: `contains_all ${pyListRepr(vs)}` };
  }
  if (kind === "min_length") {
    const n = pyIntCoerce(spec["value"]);
    return { passed: text.length >= n, label: `min_length ${n}` };
  }
  return { passed: false, label: `unknown verifier kind ${pyStrRepr(String(kind))}` };
}

/** Python-style coercion to int: bool→int, number→trunc, string→parse,
 *  anything else→0. Matches what Python's `int(x)` would do on the
 *  values that flow through here (typed JSON inputs). */
function pyIntCoerce(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x));
}

/** Build the standard "error" envelope Python emits via `_error()`. */
function errorEnvelope(code: string, message: string, hint: string): Record<string, unknown> {
  return {
    error:         message,
    error_code:    code,
    error_kind:    "client",
    operator_hint: hint,
    transient:     false,
  };
}

/** A single check result, shape-matched to Python's output. */
interface CheckResult {
  id:     string;
  kind:   string | null;
  passed: boolean;
  reason: string;
  [k: string]: unknown;
}

/** Run the verify tool natively. When `bridge` is provided, shell /
 *  url_head checks are dispatched as a whole-call to Python (preserving
 *  byte-equal for those advanced kinds). When not, those kinds return
 *  a clear native error. */
export async function runVerify(
  args: Record<string, unknown>,
  bridge: BridgeHandle | undefined,
): Promise<Record<string, unknown>> {
  const checks = args["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    return {
      tool: "verify",
      ...errorEnvelope(
        "VERIFY_MISSING_CHECKS",
        "must provide a non-empty `checks` list",
        "Each check is {kind, ...}; see schema for the supported kinds.",
      ),
    };
  }

  // If any check is shell/url_head, defer the WHOLE call to the bridge
  // — that way the Python implementation owns env/subprocess/network
  // and our parity gate stays byte-equal. When no bridge is available,
  // fall through to the native loop and emit a clear error per such
  // check; the text-kind checks still run normally.
  const needsBridge = checks.some((c) =>
    isObj(c) && (c["kind"] === "shell" || c["kind"] === "url_head"),
  );
  if (needsBridge && bridge) {
    const r = await bridge.callTool("verify", args);
    const text = r.content[0]?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { /* fall through to error */ }
    }
    return {
      tool: "verify",
      ...errorEnvelope(
        "VERIFY_BRIDGE_BAD_ENVELOPE",
        "bridge returned an unparseable envelope for verify",
        "Check that the Python child is healthy.",
      ),
    };
  }

  const allowShell = Boolean(args["allow_shell"] ?? false);
  const wallStart  = performance.now();
  const cpuStart   = process.cpuUsage();

  const results: CheckResult[] = [];
  for (let i = 0; i < checks.length; i++) {
    const spec = checks[i];
    if (!isObj(spec) || !spec["kind"]) {
      results.push({
        id:     `check${i + 1}`,
        kind:   null,
        passed: false,
        reason: "check missing `kind`",
      });
      continue;
    }
    const kind = String(spec["kind"]).toLowerCase();
    const cid  = String(spec["id"] || `check${i + 1}`);

    if (TEXT_KINDS.has(kind)) {
      const target = String(spec["target_text"] ?? "");
      const ev = evalVerifier({ ...spec, kind }, target);
      results.push({
        id: cid, kind, passed: ev.passed,
        reason: ev.passed ? "ok" : `failed: ${ev.label}`,
      });
      continue;
    }
    if (kind === "shell") {
      if (!allowShell) {
        results.push({
          id: cid, kind: "shell", passed: false,
          reason: "shell checks disabled; pass `allow_shell:true` to opt in",
        });
        continue;
      }
      // allowShell + no bridge: native does not implement subprocess.
      results.push({
        id: cid, kind: "shell", passed: false,
        reason: "shell checks require bridge mode (CROSSCHECK_BRIDGE_PYTHON=1)",
      });
      continue;
    }
    if (kind === "url_head") {
      results.push({
        id: cid, kind: "url_head", passed: false,
        reason: "url_head checks require bridge mode (CROSSCHECK_BRIDGE_PYTHON=1)",
      });
      continue;
    }
    results.push({
      id: cid, kind, passed: false,
      reason: `unknown check kind ${pyStrRepr(kind)}`,
    });
  }

  const passedN    = results.reduce((n, r) => n + (r.passed ? 1 : 0), 0);
  const allPassed  = results.length > 0 && passedN === results.length;
  const wallMs     = Math.trunc(performance.now() - wallStart);
  const cpuUsage   = process.cpuUsage(cpuStart);
  const cpuMs      = Math.trunc((cpuUsage.user + cpuUsage.system) / 1000);

  return {
    tool:       "verify",
    checks_run: results.length,
    results,
    all_passed: allPassed,
    summary:    `${passedN} of ${results.length} checks passed`,
    timing:     { wall_ms: wallMs, cpu_ms: cpuMs },
    // Phase 5 part 1: run_summary intentionally omitted; Python emits it
    // best-effort (try/except) so absence is a valid Python output too.
    // session_memory port will re-add it.
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
