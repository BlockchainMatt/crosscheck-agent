// Cross-language parity: OpenAI-compatible adapter (used by
// openai / xai / mistral / groq / deepseek).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyPricing,
  buildOpenAICompatibleRequest,
  parseOpenAICompatibleResponse,
} from "../../src/providers/openai-compatible.js";
import type { PricingDoc } from "../../src/core/pricing.js";

interface RequestCase {
  label: string;
  provider: string;
  model: string;
  url: string;
  api_key: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  expected: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
}

interface ResponseCase {
  label: string;
  provider: string;
  model: string;
  resp: Record<string, unknown>;
  purpose: string;
  expected: { text: string; usage: Record<string, unknown> };
}

interface Fixture {
  module: string;
  case_count: number;
  pricing_doc: PricingDoc;
  req_cases: readonly RequestCase[];
  resp_cases: readonly ResponseCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/openai_compat.json", import.meta.url), "utf8"),
) as Fixture;

describe(`parity: openai_compat (${fixture.case_count} cases)`, () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("openai_compat");
  });

  it.each(fixture.req_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const built = buildOpenAICompatibleRequest({
        provider:    c.provider,
        model:       c.model,
        apiKey:      c.api_key,
        url:         c.url,
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
      const parsed = parseOpenAICompatibleResponse({
        resp:     c.resp,
        provider: c.provider,
        model:    c.model,
        purpose:  c.purpose,
      });
      const withCost = applyPricing(parsed.usage, fixture.pricing_doc);
      expect({ text: parsed.text, usage: withCost }).toEqual(c.expected);
    },
  );
});
