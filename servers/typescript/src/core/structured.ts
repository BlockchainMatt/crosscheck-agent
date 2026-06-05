// Structured-output orchestrator. Direct port of Python's
// `_request_structured` (the no-worker_tools branch).
//
// Why this exists: every LLM tool that needs typed output (pick, audit,
// confer, debate, …) calls this same orchestrator. It:
//   1. Appends a "return ONLY JSON matching SCHEMA" instruction to the
//      system message (creating one if there isn't one).
//   2. Calls the provider once.
//   3. Extracts JSON from the (possibly noisy) response text.
//   4. Validates against the schema.
//   5. On validation failure, retries up to `maxRetries` more times,
//      feeding the validation errors back as a user message.
//
// Returns {obj, answer, errors}:
//   - obj: the parsed + validated value, or null if all retries failed.
//   - answer: the LAST provider answer envelope (success or error).
//     Carries the usage/timing/cache-hit fields the tool needs for its
//     own rollups.
//   - errors: empty when obj is non-null; otherwise the validation /
//     parse / provider-error message list.
//
// We intentionally DO NOT port the worker_tools branch here — that's
// the tool-using-LLM variant that interleaves verify/fetch hops with
// the structured emission. It belongs in a separate orchestrator when
// confer/solve port natively. (Phase 5+ tool-by-tool.)

import { extractJson } from "./extract-json.js";
import { validateSchema } from "./json-schema.js";
import { emptyUsage, type Usage } from "./usage.js";

import type { ChatMessage, Provider } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";

/** The "ans" envelope passed back. Mirrors Python's `_ask_one` return
 *  dict — fields are optional so success/error variants share one type. */
export interface AskAnswer {
  provider: string;
  model: string;
  /** Present on success — the raw text the provider emitted. */
  response?: string;
  /** Present on failure — short human description. */
  error?: string;
  /** Present on failure — classified kind (auth | rate_limit | server
   *  | client | timeout | network | parse | other). */
  error_kind?: string;
  attempts: number;
  usage: Usage;
  /** Whether the call hit the cache layer. Always false here (cache
   *  not ported yet). */
  cache_hit: boolean;
  elapsed_ms: number;
  cpu_ms: number;
  timing: { wall_ms: number; cpu_ms: number };
}

/** Result of `requestStructured`. */
export interface StructuredResult {
  /** The parsed + validated value, or null when no retry produced one. */
  obj: unknown | null;
  /** The LAST provider answer envelope (success or failure). */
  answer: AskAnswer;
  /** Empty when obj is non-null. Otherwise: validation errors, parse
   *  failure, or provider error message. */
  errors: string[];
}

export interface RequestStructuredOptions {
  /** Soft maximum on response tokens. Plumbed to provider.send. */
  maxTokens: number;
  /** Sampling temperature. Defaults to 0.4 (matches Python CFG default). */
  temperature?: number;
  /** Caller's purpose tag — flows into usage records. */
  purpose?: string;
  /** Retries AFTER the first attempt. Default 1 (matches Python). */
  maxRetries?: number;
  /** Optional abort signal — propagated to provider.send. */
  signal?: AbortSignal;
}

/** Call a provider once, asking it to return JSON matching `schema`.
 *  On validation failure, retry up to `maxRetries` times feeding the
 *  errors back. Returns the parsed obj or null with the failure trail. */
export async function requestStructured(
  provider:     Provider,
  baseMessages: readonly ChatMessage[],
  schema:       Record<string, unknown>,
  opts:         RequestStructuredOptions,
): Promise<StructuredResult> {
  const maxRetries = opts.maxRetries ?? 1;
  const purpose    = opts.purpose ?? "worker";
  const temp       = opts.temperature ?? 0.4;

  // JSON.stringify with no spacing arg is compact (",":") — matches
  // Python's json.dumps(schema, separators=(",", ":")) byte-for-byte
  // for any JSON-shaped schema.
  const schemaText = JSON.stringify(schema);
  const instr =
    "\n\nReturn ONLY a single JSON object matching this schema. " +
    "No commentary, no markdown fences, no prose around it.\n" +
    `SCHEMA:\n${schemaText}`;

  // Find the first system message (if any) so we know whether to
  // append or insert. Mirrors Python's `sys_idx` lookup.
  const sysIdx = baseMessages.findIndex((m) => m.role === "system");

  let lastAnswer: AskAnswer = {
    provider: provider.name, model: provider.model,
    attempts: 0, usage: emptyUsage(provider.name, provider.model, purpose),
    cache_hit: false, elapsed_ms: 0, cpu_ms: 0,
    timing: { wall_ms: 0, cpu_ms: 0 },
  };
  let lastErrs: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Build the per-attempt message list.
    const msgs: ChatMessage[] = baseMessages.map((m) => ({ ...m }));
    if (sysIdx !== -1) {
      msgs[sysIdx] = { ...msgs[sysIdx]!,
                       content: (msgs[sysIdx]!.content as string) + instr };
    } else {
      msgs.unshift({ role: "system", content: instr.trim() });
    }
    if (attempt > 0 && lastErrs.length > 0) {
      msgs.push({
        role: "user",
        content:
          "Your previous response failed validation:\n- " +
          lastErrs.slice(0, 5).join("\n- ") +
          "\nFix the issues and re-emit valid JSON only.",
      });
    }

    const ans = await askOne(provider, msgs, {
      maxTokens: opts.maxTokens, temperature: temp, purpose,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    lastAnswer = ans;

    if (ans.error !== undefined) {
      return {
        obj: null,
        answer: ans,
        errors: [`provider error: ${ans.error_kind ?? "other"}: ${ans.error}`],
      };
    }

    const obj = extractJson(ans.response ?? "");
    if (obj === null) {
      lastErrs = ["could not parse JSON from response"];
      continue;
    }
    const errs = validateSchema(
      obj as Record<string, unknown>,
      schema,
    );
    if (errs.length === 0) {
      return { obj, answer: ans, errors: [] };
    }
    lastErrs = errs;
  }
  return { obj: null, answer: lastAnswer, errors: lastErrs };
}

/** Minimal one-shot provider call. Returns an envelope mirroring
 *  Python's `_ask_one` shape (sans cache + adapter machinery, which
 *  port later). Errors are classified via the existing `ProviderError`
 *  type. */
export async function askOne(
  provider: Provider,
  messages: readonly ChatMessage[],
  opts: {
    maxTokens:   number;
    temperature: number;
    purpose:     string;
    signal?:     AbortSignal;
  },
): Promise<AskAnswer> {
  const startedWall = performance.now();
  const startedCpu  = process.cpuUsage();
  try {
    const r = await provider.send({
      messages,
      maxTokens:   opts.maxTokens,
      temperature: opts.temperature,
      purpose:     opts.purpose,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const wallMs = Math.trunc(performance.now() - startedWall);
    const cpu    = process.cpuUsage(startedCpu);
    const cpuMs  = Math.trunc((cpu.user + cpu.system) / 1000);
    return {
      provider: provider.name,
      model:    provider.model,
      response: r.text,
      attempts: r.attempts,
      usage:    r.usage,
      cache_hit: false,
      elapsed_ms: wallMs,
      cpu_ms:     cpuMs,
      timing:     { wall_ms: wallMs, cpu_ms: cpuMs },
    };
  } catch (e) {
    const wallMs = Math.trunc(performance.now() - startedWall);
    const cpu    = process.cpuUsage(startedCpu);
    const cpuMs  = Math.trunc((cpu.user + cpu.system) / 1000);
    const kind   = e instanceof ProviderError ? e.kind : "other";
    const msg    = e instanceof Error ? e.message : String(e);
    return {
      provider: provider.name,
      model:    provider.model,
      error:    msg,
      error_kind: kind,
      attempts: 0,
      usage:    emptyUsage(provider.name, provider.model, opts.purpose),
      cache_hit: false,
      elapsed_ms: wallMs,
      cpu_ms:     cpuMs,
      timing:     { wall_ms: wallMs, cpu_ms: cpuMs },
    };
  }
}
