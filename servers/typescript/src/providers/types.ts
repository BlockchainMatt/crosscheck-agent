// Provider interface — minimal surface every LLM adapter implements.
//
// Mirrors Python's `Provider` dataclass + `send()` signature (text +
// attempts + usage). Each per-provider module exports a factory that
// reads env vars and returns a `Provider | null` (null when the API
// key is missing).

import type { Usage } from "../core/usage.js";

/** Inbound message shape — chat-completions style. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | string;
  content: string;
  [k: string]: unknown;
}

/** A successful `send()` result. */
export interface SendResult {
  /** Concatenated text from the provider response. */
  text: string;
  /** Number of HTTP attempts that produced this result (>= 1). */
  attempts: number;
  /** Parsed + cost-augmented usage record. */
  usage: Usage;
}

/** Args passed into every `Provider.send()` call. Mirrors the Python
 *  `send(messages, max_tokens, temperature, purpose='worker')` signature
 *  plus an optional `signal` for cancellation. */
export interface SendArgs {
  messages: readonly ChatMessage[];
  maxTokens: number;
  temperature: number;
  purpose?: string;
  /** Optional AbortSignal so callers can cancel long-running calls. */
  signal?: AbortSignal;
}

/** Provider adapter. */
export interface Provider {
  /** Lowercased identifier (e.g. "anthropic", "openai"). */
  readonly name: string;
  /** Default model for this provider (env-resolved at factory time). */
  readonly model: string;
  /** Make a request and return the parsed result. Throws `ProviderError`
   *  on classified failures (auth, rate_limit, timeout, server, parse,
   *  network, client). */
  send(args: SendArgs): Promise<SendResult>;
}

/** Classified provider error. Mirrors Python's `ProviderError`. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly transient: boolean;
  readonly retryAfterS?: number;
  constructor(kind: ErrorKind, message: string, opts?: {
    status?: number;
    transient?: boolean;
    retryAfterS?: number;
  }) {
    super(message);
    this.kind = kind;
    this.status = opts?.status;
    this.transient = opts?.transient ?? defaultTransient(kind);
    if (opts?.retryAfterS !== undefined) {
      this.retryAfterS = opts.retryAfterS;
    }
  }
}

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "server"
  | "client"
  | "timeout"
  | "network"
  | "parse"
  | "other";

function defaultTransient(kind: ErrorKind): boolean {
  return kind === "rate_limit" || kind === "server" || kind === "timeout" || kind === "network";
}
