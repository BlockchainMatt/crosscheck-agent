// Error taxonomy. Mirrors `_error` in
// `servers/python/crosscheck_server.py` byte-for-byte.
//
// Every tool that fails returns this envelope. The legacy `error` string
// stays for back-compat with old callers; the structured fields
// (`error_code` / `error_kind` / `operator_hint` / `transient`) drive
// programmatic retry decisions and operator UX.

/** Classifier for retryability + downstream alerting. Mirrors the enum
 *  Python uses across `_classify_http_error` + the error helpers. */
export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "server"
  | "client"
  | "timeout"
  | "network"
  | "parse"
  | "other";

/** Standard error envelope. Tools attach this on top of their tool-specific
 *  fields (`{"tool": "...", **error_envelope()}`). */
export interface ErrorEnvelope {
  /** Human-readable message. The historical `error` field — preserved for
   *  back-compat with old callers that only check this. */
  error: string;
  /** Stable, uppercase, snake-cased identifier (e.g. `RECALL_FTS5_UNAVAILABLE`).
   *  This is the field programmatic callers should switch on. */
  error_code: string;
  /** Failure mode classifier. Drives retry policy. */
  error_kind: ErrorKind;
  /** Short, actionable hint for the operator (config knob to tweak, command
   *  to run, etc.). Empty string when no specific hint applies. */
  operator_hint: string;
  /** When true, the caller should expect the operation to succeed on
   *  retry (e.g. a 5xx). When false, fail-closed. */
  transient: boolean;
}

export interface ErrorOptions {
  kind?: ErrorKind;
  hint?: string;
  transient?: boolean;
  /** Extra fields merged into the envelope (e.g. `schema_errors`,
   *  `retry_after_s`, ...). Mirrors Python's `**extra` kwargs splat. */
  extra?: Record<string, unknown>;
}

/** Build the structured error envelope. Defaults match Python:
 *    kind = "client", hint = "", transient = false. */
export function error(
  code: string,
  message: string,
  opts?: ErrorOptions,
): ErrorEnvelope & Record<string, unknown> {
  const out: ErrorEnvelope & Record<string, unknown> = {
    error:         message,
    error_code:    code,
    error_kind:    opts?.kind ?? "client",
    operator_hint: opts?.hint ?? "",
    transient:     Boolean(opts?.transient),
  };
  if (opts?.extra) {
    for (const [k, v] of Object.entries(opts.extra)) out[k] = v;
  }
  return out;
}
