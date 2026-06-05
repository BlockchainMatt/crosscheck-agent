// Cross-language parity: Anthropic provider adapter.
//
// Two halves:
//   - request build: `buildAnthropicRequest` produces the same wire
//     body + headers as the Python `anthropic_provider().send()` would
//     have POSTed.
//   - response parse: `parseAnthropicResponse` + `applyPricing` reproduces
//     the same (text, usage) as Python's `send()` returns, including
//     the cache-read folding into prompt_tokens.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyPricing,
  buildAnthropicRequest,
  parseAnthropicResponse,
} from "../../src/providers/anthropic.js";
import type { PricingDoc } from "../../src/core/pricing.js";

interface RequestCase {
  label: string;
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  api_key: string;
  expected: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
}

interface ResponseCase {
  label: string;
  resp: Record<string, unknown>;
  model: string;
  purpose: string;
  expected: {
    text: string;
    usage: Record<string, unknown>;
  };
}

interface Fixture {
  module: string;
  case_count: number;
  pricing_doc: PricingDoc;
  req_cases: readonly RequestCase[];
  resp_cases: readonly ResponseCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/anthropic.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: anthropic (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("anthropic");
  });

  it.each(fixture.req_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const built = buildAnthropicRequest({
        model:       c.model,
        apiKey:      c.api_key,
        messages:    c.messages,
        maxTokens:   c.max_tokens,
        temperature: c.temperature,
      });
      expect(built.url).toBe(c.expected.url);
      expect(built.headers).toEqual(c.expected.headers);
      expect(built.body).toEqual(c.expected.body);
    },
  );

  it.each(fixture.resp_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const parsed = parseAnthropicResponse({
        resp: c.resp, model: c.model, purpose: c.purpose,
      });
      const withCost = applyPricing(parsed.usage, fixture.pricing_doc);
      expect({ text: parsed.text, usage: withCost }).toEqual(c.expected);
    },
  );
});
