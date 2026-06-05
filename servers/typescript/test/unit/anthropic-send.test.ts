// End-to-end test for sendAnthropic() using the cassette replay shim.
// Proves the full flow (build → fetch → parse → applyPricing) wires
// together correctly without hitting the live API.

import { describe, expect, it } from "vitest";

import {
  type Cassette,
  replayFromCassette,
} from "../../src/providers/cassette.js";
import { sendAnthropic } from "../../src/providers/anthropic.js";

const PRICING = {
  anthropic: {
    "claude-test": {
      prompt_per_1k:     0.003,
      completion_per_1k: 0.015,
      cached_per_1k:     0.0003,
    },
  },
} as const;

const HAPPY_CASSETTE: Cassette = {
  description: "anthropic happy-path: 200 with text + usage",
  entries: [
    {
      label: "claude-test 'Hello' → 'Hi there'",
      request: {
        method: "POST",
        url:    "https://api.anthropic.com/v1/messages",
        body: {
          model: "claude-test",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }],
          temperature: 0.4,
        },
      },
      response: {
        status: 200,
        body: {
          content: [{ type: "text", text: "Hi there" }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        },
      },
    },
  ],
};

describe("sendAnthropic (cassette replay)", () => {
  it("happy path: builds + sends + parses + applies pricing", async () => {
    const result = await sendAnthropic({
      messages:    [{ role: "user", content: "Hello" }],
      maxTokens:   100,
      temperature: 0.4,
      apiKey:      "test-key",
      model:       "claude-test",
      pricing:     PRICING,
      fetchImpl:   replayFromCassette(HAPPY_CASSETTE) as never,
    });
    expect(result.text).toBe("Hi there");
    expect(result.attempts).toBe(1);
    expect(result.usage.provider).toBe("anthropic");
    expect(result.usage.model).toBe("claude-test");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.cost_usd).toBeCloseTo(0.003 * 0.01 + 0.015 * 0.005, 8);
    expect(result.usage.estimated).toBe(false);
  });

  it("HTTP 401 → ProviderError(auth)", async () => {
    const cassette: Cassette = {
      entries: [{
        label: "401 auth",
        request: { method: "POST", url: "https://api.anthropic.com/v1/messages" },
        response: { status: 401, body: { error: { type: "authentication_error" } } },
      }],
    };
    await expect(sendAnthropic({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10, temperature: 0.4,
      apiKey: "bad-key", model: "claude-test", pricing: PRICING,
      fetchImpl: replayFromCassette(cassette) as never,
    })).rejects.toMatchObject({ kind: "auth" });
  });

  it("HTTP 429 → ProviderError(rate_limit, transient=true)", async () => {
    const cassette: Cassette = {
      entries: [{
        label: "429",
        request: { method: "POST", url: "https://api.anthropic.com/v1/messages" },
        response: { status: 429, body: { error: { type: "rate_limit_error" } } },
      }],
    };
    await expect(sendAnthropic({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10, temperature: 0.4,
      apiKey: "k", model: "claude-test", pricing: PRICING,
      fetchImpl: replayFromCassette(cassette) as never,
    })).rejects.toMatchObject({ kind: "rate_limit", transient: true });
  });

  it("HTTP 500 → ProviderError(server, transient=true)", async () => {
    const cassette: Cassette = {
      entries: [{
        label: "500",
        request: { method: "POST", url: "https://api.anthropic.com/v1/messages" },
        response: { status: 500, body: { error: "boom" } },
      }],
    };
    await expect(sendAnthropic({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10, temperature: 0.4,
      apiKey: "k", model: "claude-test", pricing: PRICING,
      fetchImpl: replayFromCassette(cassette) as never,
    })).rejects.toMatchObject({ kind: "server", transient: true });
  });

  it("non-array content → ProviderError(parse)", async () => {
    const cassette: Cassette = {
      entries: [{
        label: "weird shape",
        request: { method: "POST", url: "https://api.anthropic.com/v1/messages" },
        response: { status: 200, body: { content: "not-an-array" } },
      }],
    };
    await expect(sendAnthropic({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10, temperature: 0.4,
      apiKey: "k", model: "claude-test", pricing: PRICING,
      fetchImpl: replayFromCassette(cassette) as never,
    })).rejects.toMatchObject({ kind: "parse" });
  });

  it("cassette request-body mismatch raises", async () => {
    await expect(sendAnthropic({
      messages: [{ role: "user", content: "DIFFERENT" }],
      maxTokens: 100, temperature: 0.4,
      apiKey: "test-key", model: "claude-test", pricing: PRICING,
      fetchImpl: replayFromCassette(HAPPY_CASSETTE) as never,
    })).rejects.toThrow(/request body mismatch/);
  });
});
