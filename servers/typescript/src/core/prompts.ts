// Provider-specific prompt adapters.
//
// Mirrors `_adapt_messages` + `_strip_reasoning_preamble` +
// `_anthropic_xml_wrap` + `_prompt_adapters_enabled` from
// `servers/python/crosscheck_server.py` byte-for-byte. Two adaptations
// ship:
//
//   1. Reasoning-class preamble strip (gpt-5, o-series, claude-opus-4-7+,
//      gemini-2.5-pro). Removes "let's think step by step" / "think out
//      loud" preambles — these models do that internally; the explicit
//      asks burn tokens for no gain.
//
//   2. Anthropic XML wrap. When the final user message is long (≥ 600
//      chars) and not already XML-tagged, restructure as
//      <instructions>...</instructions> + <task>...</task>. Claude
//      follows XML-structured prompts more reliably.
//
// The reasoning-preamble regex MUST match Python's `_REASONING_PREAMBLE_RE`
// byte-for-byte (alternation order, case-insensitive flag, anchored
// post-match `\.?\s*`). The parity fixture exercises a wide grid; any
// drift fails CI.

import { isReasoningModel } from "./provider-caps.js";

/** Default for `prompt_adapters.enabled` when the key is missing. */
export const PROMPT_ADAPTERS_ENABLED_DEFAULT = true;

/** Minimum user-message body length before the Anthropic XML wrap fires. */
export const ANTHROPIC_XML_WRAP_MIN_CHARS = 600;

/** The reasoning-preamble regex. Equivalent to Python's
 *  `_REASONING_PREAMBLE_RE`. Case-insensitive. `g` flag is required
 *  because we use `replace()` (Python uses `subn` which is global by
 *  default). */
export const REASONING_PREAMBLE_RE = new RegExp(
  "\\b(let's|let us|please)?\\s*think (out loud|step[\\s\\-]by[\\s\\-]step|aloud|carefully)" +
    "(\\s+(before|first)\\s+(answering|responding|replying))?\\.?\\s*",
  "gi",
);

/** Detect when the body already has caller-supplied XML structure. */
const ALREADY_TAGGED_RE = /<(task|context|input|untrusted_input|instructions)\b/i;

/** Collapse 3+ consecutive newlines down to exactly two — matches Python's
 *  `re.sub(r"\n{3,}", "\n\n", new_content)` semantics. */
const TRIPLE_NEWLINE_RE = /\n{3,}/g;

export interface PromptAdaptersConfig {
  enabled?: boolean;
}

/** A single message in the chat-completions shape. We mirror Python's
 *  dict-or-other tolerance: non-dict entries pass through unchanged. */
export type ChatMessage =
  | { role: string; content: unknown; [k: string]: unknown }
  | unknown;

export interface AdaptInfo {
  /** Adapters that fired, formatted as `"<name>"` or `"<name>:<count>"`.
   *  Matches Python's `info["applied"]` shape. */
  applied: string[];
}

/** Resolve whether prompt adapters are enabled. Mirrors
 *  `_prompt_adapters_enabled` semantics. */
export function promptAdaptersEnabled(cfg?: PromptAdaptersConfig | unknown): boolean {
  if (!cfg || typeof cfg !== "object") return PROMPT_ADAPTERS_ENABLED_DEFAULT;
  const c = cfg as PromptAdaptersConfig;
  if (typeof c.enabled !== "boolean") return PROMPT_ADAPTERS_ENABLED_DEFAULT;
  return c.enabled;
}

/** Strip reasoning preambles from every string-typed `content` field in
 *  `messages`. Returns `(new_messages, edits)` where `edits` is the
 *  total number of substitutions across all messages (sum of regex
 *  match counts). Mirrors Python's `_strip_reasoning_preamble`. */
export function stripReasoningPreamble(
  messages: readonly ChatMessage[],
): { messages: ChatMessage[]; edits: number } {
  const out: ChatMessage[] = [];
  let edits = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      out.push(m);
      continue;
    }
    const msg = m as { content?: unknown };
    const content = msg.content;
    if (typeof content === "string") {
      REASONING_PREAMBLE_RE.lastIndex = 0;
      // Count matches first (so we can return the total `edits`).
      const matches = content.match(REASONING_PREAMBLE_RE);
      const n = matches ? matches.length : 0;
      if (n > 0) {
        edits += n;
        REASONING_PREAMBLE_RE.lastIndex = 0;
        const stripped = content.replace(REASONING_PREAMBLE_RE, "");
        const collapsed = stripped.replace(TRIPLE_NEWLINE_RE, "\n\n").trim();
        out.push({ ...(m as Record<string, unknown>), content: collapsed });
        continue;
      }
    }
    out.push(m);
  }
  return { messages: out, edits };
}

/** Wrap the final user message in `<instructions>`+`<task>` blocks when:
 *    - there is a user message
 *    - its body is a string of length ≥ ANTHROPIC_XML_WRAP_MIN_CHARS
 *    - it doesn't already contain task/context/input/untrusted_input/instructions tags
 *
 *  The original system message is NOT removed — Anthropic's send() reads
 *  it from body.system. Returns `(new_messages, edits)` where edits is
 *  0 or 1. Mirrors Python's `_anthropic_xml_wrap`. */
export function anthropicXmlWrap(
  messages: readonly ChatMessage[],
): { messages: ChatMessage[]; edits: number } {
  if (messages.length === 0) return { messages: [...messages], edits: 0 };
  // First system message (if any).
  const sysMsg = messages.find(
    (m): m is { role: string; content: unknown } =>
      !!m && typeof m === "object" && (m as { role?: unknown }).role === "system",
  );
  // Last user message index (search from the end — matches Python's reverse iteration).
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && (m as { role?: unknown }).role === "user") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return { messages: [...messages], edits: 0 };
  const userMsg = messages[userIdx] as { role: string; content?: unknown };
  const body = userMsg.content;
  if (typeof body !== "string" || body.length < ANTHROPIC_XML_WRAP_MIN_CHARS) {
    return { messages: [...messages], edits: 0 };
  }
  if (ALREADY_TAGGED_RE.test(body)) {
    return { messages: [...messages], edits: 0 };
  }
  const sysText =
    sysMsg && typeof sysMsg.content === "string"
      ? sysMsg.content.trim()
      : "";
  const wrapped =
    (sysText ? `<instructions>\n${sysText}\n</instructions>\n\n` : "") +
    `<task>\n${body.trim()}\n</task>`;
  const newMessages: ChatMessage[] = [...messages];
  newMessages[userIdx] = { ...(userMsg as Record<string, unknown>), content: wrapped };
  return { messages: newMessages, edits: 1 };
}

/** Apply per-provider/per-purpose prompt adaptations. Mirrors
 *  `_adapt_messages` in Python. The `info.applied` list records which
 *  adapters fired (with counts where applicable). */
export function adaptMessages(
  provider: string,
  model: string,
  _purpose: string,
  messages: readonly ChatMessage[],
  cfg?: PromptAdaptersConfig | unknown,
): { messages: ChatMessage[]; info: AdaptInfo } {
  if (!promptAdaptersEnabled(cfg)) {
    return { messages: [...messages], info: { applied: [] } };
  }
  const applied: string[] = [];
  let out: ChatMessage[] = [...messages];

  if (isReasoningModel(provider, model)) {
    const r = stripReasoningPreamble(out);
    if (r.edits > 0) {
      out = r.messages;
      applied.push(`reasoning_preamble_strip:${r.edits}`);
    }
  }

  if (provider === "anthropic") {
    const r = anthropicXmlWrap(out);
    if (r.edits > 0) {
      out = r.messages;
      applied.push("anthropic_xml_wrap");
    }
  }

  return { messages: out, info: { applied } };
}
