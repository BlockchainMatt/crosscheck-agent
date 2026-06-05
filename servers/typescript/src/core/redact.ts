// PII / secret redaction. Mirrors `_redact_text` + `_redact_obj` from
// `servers/python/crosscheck_server.py`, including HMAC mode.
//
// Built-in patterns (must stay byte-equivalent with the Python list):
//   - EMAIL    — local@domain.tld
//   - IP       — IPv4 dotted-quad
//   - AWS_KEY  — AKIA + 16 base32 chars
//   - TOKEN    — github (gh{p,o,u,s,r}_...), Slack (xox*), OpenAI (sk-...)
//   - TOKEN    — `Authorization: Bearer <token>` (prefix preserved)
//   - CARD     — 16-digit, optional spaces/dashes
//
// `enabled: false` short-circuits. `hmac_tokens: true` derives an 8-char
// hex suffix from HMAC(secret + session_id, "<label>:<match>") so the
// same PII redacted in the same session reuses the same opaque token.
// Different sessions or different secrets produce different suffixes.

import { createHmac } from "node:crypto";

/** A single redaction rule. `prefix_group: true` means the regex has a
 *  capture group that should be preserved verbatim (e.g. the
 *  "Authorization: Bearer " header is kept; only the token is replaced). */
export interface RedactionRule {
  pattern: RegExp;
  label: string;
  prefix_group: boolean;
}

/** Build the built-in rules. Each call returns FRESH RegExp objects so
 *  callers don't leak `lastIndex` state between invocations. */
export function builtinRedactionRules(): RedactionRule[] {
  return [
    { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,                                              label: "EMAIL",   prefix_group: false },
    { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,                                                     label: "IP",      prefix_group: false },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g,                                                                       label: "AWS_KEY", prefix_group: false },
    { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g,      label: "TOKEN",   prefix_group: false },
    { pattern: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9_\-.=]{20,}/gi,                                   label: "TOKEN",   prefix_group: true  },
    { pattern: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,                                                                 label: "CARD",    prefix_group: false },
  ];
}

/** Redaction configuration. Mirrors `_redaction_cfg()` keys + adds
 *  explicit secret + session_id for HMAC mode (Python pulls these from
 *  a process-global + thread-local; we pass them through). */
export interface RedactionConfig {
  /** Master switch; default true. */
  enabled?: boolean;
  /** When true, replacement tokens carry an 8-hex HMAC suffix derived
   *  from (secret + session_id, "<label>:<match>"). */
  hmac_tokens?: boolean;
  /** Additional regex sources appended to the built-in list as label "EXTRA". */
  patterns_extra?: readonly string[];
  /** HMAC secret. Required when `hmac_tokens: true`. In production this
   *  is a process-rotating random buffer; tests pass a fixed Buffer. */
  hmac_secret?: Buffer | Uint8Array;
  /** Session-id suffix to the HMAC key; same value in same session +
   *  same secret → same opaque token. Default: "". */
  session_id?: string;
}

interface CompiledRules {
  rules: RedactionRule[];
}

/** Build a per-call compiled rule set. Caches built-in rules implicitly
 *  via the regex literals (their structure never changes); appended
 *  custom rules compile fresh each time so an invalid regex doesn't
 *  poison subsequent calls. */
function compileRules(cfg: RedactionConfig | undefined): CompiledRules {
  const rules = builtinRedactionRules();
  const extras = cfg?.patterns_extra ?? [];
  for (const src of extras) {
    try {
      rules.push({ pattern: new RegExp(src, "g"), label: "EXTRA", prefix_group: false });
    } catch {
      // Skip invalid patterns silently (matches Python's `continue` behavior).
    }
  }
  return { rules };
}

/** Compute the 8-char HMAC suffix. Mirrors `_redaction_hmac_suffix`:
 *  digest = HMAC-SHA256(secret + session_id, "<label>:<value>");
 *  suffix = hex(digest)[:8]. */
function hmacSuffix(
  cfg: RedactionConfig,
  label: string,
  value: string,
): string {
  const secret = cfg.hmac_secret ?? Buffer.alloc(0);
  const sid    = cfg.session_id ?? "";
  // Key = secret bytes concatenated with the session-id UTF-8 bytes.
  const sidBytes = Buffer.from(sid, "utf8");
  const key = Buffer.concat([Buffer.from(secret), sidBytes]);
  const digest = createHmac("sha256", key)
    .update(`${label}:${value}`, "utf8")
    .digest("hex");
  return digest.slice(0, 8);
}

/** Redact a string. Non-string inputs and empty strings pass through.
 *  Mirrors `_redact_text` in Python.
 *
 *  Notes on parity:
 *   - We use `String.replace(regex, fn)` which provides the match + capture
 *     groups, matching Python's `re.sub(pattern, sub_fn, s)`.
 *   - The `prefix_group` rule preserves capture group 1 verbatim and
 *     replaces only the post-group part. */
export function redactText(s: unknown, cfg?: RedactionConfig): string {
  if (typeof s !== "string" || s.length === 0) return s as string;
  if (cfg && cfg.enabled === false) return s;
  const { rules } = compileRules(cfg);
  const hmacMode = Boolean(cfg?.hmac_tokens);
  let out = s;
  for (const { pattern, label, prefix_group } of rules) {
    pattern.lastIndex = 0;
    if (hmacMode) {
      out = out.replace(pattern, (match: string, ...args: unknown[]) => {
        const suffix = hmacSuffix(cfg ?? {}, label, match);
        const token = `[REDACTED_${label}:${suffix}]`;
        if (prefix_group) {
          // args = [g1, ..., offset, fullString, groups?]; g1 is the first capture.
          const g1 = args[0];
          if (typeof g1 === "string") return g1 + token;
        }
        return token;
      });
    } else {
      out = out.replace(pattern, (match: string, ...args: unknown[]) => {
        if (prefix_group) {
          const g1 = args[0];
          if (typeof g1 === "string") return `${g1}[REDACTED_${label}]`;
        }
        return `[REDACTED_${label}]`;
      });
    }
  }
  return out;
}

/** Walk a JSON-like value, redacting every string in place. Arrays /
 *  objects are recursed; everything else passes through. Mirrors
 *  `_redact_obj` in Python. */
export function redactObj<T>(obj: T, cfg?: RedactionConfig): T {
  if (typeof obj === "string") return redactText(obj, cfg) as unknown as T;
  if (Array.isArray(obj)) {
    return obj.map((v) => redactObj(v, cfg)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = redactObj(v, cfg);
    }
    return out as unknown as T;
  }
  return obj;
}
