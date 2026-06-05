// Unit tests for the provider registry. Verifies that:
//   - Providers without an API key are silently omitted.
//   - Default models match Python's `build_providers()` defaults.
//   - <PROVIDER>_MODEL env overrides take precedence over defaults.
//   - The full 7-provider lineup builds when all keys are present.

import { describe, expect, it } from "vitest";

import {
  buildProviders,
  DEFAULT_MODELS,
} from "../../src/providers/registry.js";

const EMPTY_PRICING = {} as const;

describe("buildProviders", () => {
  it("returns empty when no API keys are set", () => {
    const out = buildProviders({ env: {}, pricing: EMPTY_PRICING });
    expect(Object.keys(out)).toEqual([]);
  });

  it("includes only providers whose API key is set", () => {
    const out = buildProviders({
      env: {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY:    "o",
        // xai/mistral/groq/deepseek/gemini intentionally missing
      },
      pricing: EMPTY_PRICING,
    });
    expect(Object.keys(out).sort()).toEqual(["anthropic", "openai"]);
  });

  it("uses default models when <PROVIDER>_MODEL is missing", () => {
    const out = buildProviders({
      env: {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY:    "o",
        XAI_API_KEY:       "x",
        MISTRAL_API_KEY:   "m",
        GROQ_API_KEY:      "g",
        DEEPSEEK_API_KEY:  "d",
        GEMINI_API_KEY:    "j",
      },
      pricing: EMPTY_PRICING,
    });
    expect(out["anthropic"]?.model).toBe(DEFAULT_MODELS.anthropic);
    expect(out["openai"]?.model).toBe(DEFAULT_MODELS.openai);
    expect(out["xai"]?.model).toBe(DEFAULT_MODELS.xai);
    expect(out["mistral"]?.model).toBe(DEFAULT_MODELS.mistral);
    expect(out["groq"]?.model).toBe(DEFAULT_MODELS.groq);
    expect(out["deepseek"]?.model).toBe(DEFAULT_MODELS.deepseek);
    expect(out["gemini"]?.model).toBe(DEFAULT_MODELS.gemini);
  });

  it("honors <PROVIDER>_MODEL env overrides", () => {
    const out = buildProviders({
      env: {
        ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-test",
        OPENAI_API_KEY:    "k", OPENAI_MODEL:    "gpt-test",
        GEMINI_API_KEY:    "k", GEMINI_MODEL:    "gemini-test",
      },
      pricing: EMPTY_PRICING,
    });
    expect(out["anthropic"]?.model).toBe("claude-test");
    expect(out["openai"]?.model).toBe("gpt-test");
    expect(out["gemini"]?.model).toBe("gemini-test");
  });

  it("builds the full 7-provider lineup when all keys are set", () => {
    const out = buildProviders({
      env: {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY:    "o",
        XAI_API_KEY:       "x",
        MISTRAL_API_KEY:   "m",
        GROQ_API_KEY:      "g",
        DEEPSEEK_API_KEY:  "d",
        GEMINI_API_KEY:    "j",
      },
      pricing: EMPTY_PRICING,
    });
    expect(Object.keys(out).sort()).toEqual([
      "anthropic", "deepseek", "gemini", "groq", "mistral", "openai", "xai",
    ]);
    // Iteration order matches Python's dict literal: anthropic first,
    // openai-compatible bundle, gemini last.
    expect(Object.keys(out)).toEqual([
      "anthropic", "openai", "xai", "mistral", "groq", "deepseek", "gemini",
    ]);
  });

  it("each Provider has a name + model + send() function", () => {
    const out = buildProviders({
      env: { ANTHROPIC_API_KEY: "a" },
      pricing: EMPTY_PRICING,
    });
    const p = out["anthropic"]!;
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe(DEFAULT_MODELS.anthropic);
    expect(typeof p.send).toBe("function");
  });
});
