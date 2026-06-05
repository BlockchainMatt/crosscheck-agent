// requestStructured orchestrator tests.
//
// Pure unit tests using mock providers — no network, no cassettes.
// The cross-language parity for extractJson + validateSchema is
// covered by test/parity/{extract_json,json_schema}.test.ts. This file
// covers the orchestration logic on top of those primitives:
//
//   1. Happy path: valid JSON on first try → (obj, ans, [])
//   2. Invalid JSON: parse fails → retry, then either succeed or fail
//   3. Validation failure: parse OK but schema rejects → retry with
//      feedback containing the validation errors → eventual success
//   4. Provider error: send() throws ProviderError → immediate return
//      with classified error_kind
//   5. The schema-text instruction matches Python's byte-for-byte
//      shape: appended to existing system message OR inserted as new
//      system message at index 0.
//   6. Retry feedback message contains the first 5 errors only.

import { describe, expect, it } from "vitest";

import { requestStructured } from "../../src/core/structured.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { ChatMessage, Provider, SendArgs, SendResult } from "../../src/providers/types.js";
import { ProviderError } from "../../src/providers/types.js";

/** A mock provider whose `send()` returns canned responses (in order)
 *  and captures the messages it was called with. */
function mockProvider(responses: (string | ProviderError)[]): {
  provider: Provider;
  calls: { messages: ChatMessage[]; maxTokens: number }[];
} {
  const calls: { messages: ChatMessage[]; maxTokens: number }[] = [];
  let cursor = 0;
  const provider: Provider = {
    name:  "mock",
    model: "mock-model",
    send: async (args: SendArgs): Promise<SendResult> => {
      calls.push({
        messages: args.messages.map((m) => ({ ...m })),
        maxTokens: args.maxTokens,
      });
      if (cursor >= responses.length) {
        throw new Error(`mock provider exhausted (${responses.length} responses)`);
      }
      const r = responses[cursor++]!;
      if (r instanceof ProviderError) throw r;
      return {
        text: r,
        attempts: 1,
        usage: { ...emptyUsage("mock", "mock-model", args.purpose), estimated: false },
      };
    },
  };
  return { provider, calls };
}

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", minLength: 1 },
    score:  { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["answer", "score"],
  additionalProperties: false,
} as const;

const BASE_MSGS: readonly ChatMessage[] = [
  { role: "system", content: "You are a scoring assistant." },
  { role: "user",   content: "Score this." },
];

describe("requestStructured — orchestration", () => {
  it("happy path: valid JSON on first try → (obj, ans, [])", async () => {
    const { provider, calls } = mockProvider([
      '{"answer": "yes", "score": 0.9}',
    ]);
    const r = await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    expect(r.errors).toEqual([]);
    expect(r.obj).toEqual({ answer: "yes", score: 0.9 });
    expect(r.answer.response).toBe('{"answer": "yes", "score": 0.9}');
    expect(calls).toHaveLength(1);
  });

  it("appends schema instruction to existing system message (not a new message)", async () => {
    const { provider, calls } = mockProvider([
      '{"answer": "ok", "score": 0.5}',
    ]);
    await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    const sysMsg = calls[0]!.messages.find((m) => m.role === "system");
    expect(sysMsg).toBeDefined();
    // System message is the original + the schema instruction appended.
    expect(sysMsg!.content).toMatch(/^You are a scoring assistant\.\n\n/);
    expect(sysMsg!.content).toContain("Return ONLY a single JSON object matching this schema.");
    expect(sysMsg!.content).toContain('SCHEMA:\n{"type":"object"');
    // base_messages MUST NOT be mutated (Python builds new dicts).
    expect(BASE_MSGS[0]!.content).toBe("You are a scoring assistant.");
  });

  it("inserts a new system message when none was provided", async () => {
    const { provider, calls } = mockProvider([
      '{"answer": "ok", "score": 0.5}',
    ]);
    await requestStructured(
      provider,
      [{ role: "user", content: "Just user." }],
      SCHEMA, { maxTokens: 100 },
    );
    expect(calls[0]!.messages[0]!.role).toBe("system");
    expect(calls[0]!.messages[0]!.content).toMatch(
      /^Return ONLY a single JSON object matching this schema\./,
    );
    expect(calls[0]!.messages[1]!.content).toBe("Just user.");
  });

  it("parse failure → retry with feedback → success", async () => {
    const { provider, calls } = mockProvider([
      "garbage no JSON here",                       // attempt 1 fails parse
      '{"answer": "ok", "score": 0.5}',             // retry succeeds
    ]);
    const r = await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    expect(r.errors).toEqual([]);
    expect(r.obj).toEqual({ answer: "ok", score: 0.5 });
    expect(calls).toHaveLength(2);
    // Retry should include a user message with the parse-failure feedback.
    const retryUser = calls[1]!.messages.find(
      (m) => m.role === "user" && m.content.includes("Your previous response failed validation"),
    );
    expect(retryUser).toBeDefined();
    expect(retryUser!.content).toContain("could not parse JSON from response");
  });

  it("validation failure → retry with errors in feedback → success", async () => {
    const { provider, calls } = mockProvider([
      '{"answer": "", "score": 2}',                 // bad: empty + over max
      '{"answer": "ok", "score": 0.5}',             // good
    ]);
    const r = await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    expect(r.errors).toEqual([]);
    expect(r.obj).toEqual({ answer: "ok", score: 0.5 });
    const retryUser = calls[1]!.messages.at(-1)!;
    expect(retryUser.role).toBe("user");
    // Errors from the first attempt land in the feedback.
    expect(retryUser.content).toContain("answer: shorter than minLength 1");
    expect(retryUser.content).toContain("score: 2 > maximum 1");
  });

  it("retry exhausted → (null, last_ans, errs)", async () => {
    const { provider } = mockProvider([
      '{"answer": "", "score": 2}',
      '{"answer": "", "score": 2}',
    ]);
    const r = await requestStructured(
      provider, BASE_MSGS, SCHEMA, { maxTokens: 100, maxRetries: 1 },
    );
    expect(r.obj).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.answer.response).toBe('{"answer": "", "score": 2}');
  });

  it("provider throws ProviderError → immediate (null, ans-with-error, [provider error msg])", async () => {
    const { provider } = mockProvider([
      new ProviderError("rate_limit", "rate limited"),
    ]);
    const r = await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    expect(r.obj).toBeNull();
    expect(r.answer.error).toBe("rate limited");
    expect(r.answer.error_kind).toBe("rate_limit");
    expect(r.errors).toEqual(["provider error: rate_limit: rate limited"]);
  });

  it("feedback message includes at most 5 errors", async () => {
    // Object with 6+ validation errors so the slice-to-5 takes effect.
    const SCHEMA6 = {
      type: "object",
      properties: {
        a: { type: "integer" }, b: { type: "integer" },
        c: { type: "integer" }, d: { type: "integer" },
        e: { type: "integer" }, f: { type: "integer" },
      },
      required: ["a", "b", "c", "d", "e", "f"],
    };
    const { provider, calls } = mockProvider([
      "{}",                                                // all 6 required missing
      '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}',            // satisfies → success
    ]);
    await requestStructured(provider, BASE_MSGS, SCHEMA6, { maxTokens: 100 });
    const feedback = calls[1]!.messages.at(-1)!.content;
    // Should have 5 "- " bullets (sliced from 6 errors).
    const bulletCount = (feedback.match(/\n- /g) ?? []).length;
    expect(bulletCount).toBe(5);
  });

  it("respects maxRetries=0 (single attempt, no retry)", async () => {
    const { provider, calls } = mockProvider(["garbage"]);
    const r = await requestStructured(
      provider, BASE_MSGS, SCHEMA, { maxTokens: 100, maxRetries: 0 },
    );
    expect(r.obj).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("temperature flows through to provider.send (default 0.4)", async () => {
    let observed: number | null = null;
    const provider: Provider = {
      name: "spy", model: "spy",
      send: async (args) => {
        observed = args.temperature;
        return { text: '{"answer":"ok","score":0.5}',
                 attempts: 1, usage: emptyUsage("spy", "spy", "worker") };
      },
    };
    await requestStructured(provider, BASE_MSGS, SCHEMA, { maxTokens: 100 });
    expect(observed).toBeCloseTo(0.4);

    await requestStructured(provider, BASE_MSGS, SCHEMA,
      { maxTokens: 100, temperature: 0.9 });
    expect(observed).toBeCloseTo(0.9);
  });
});
