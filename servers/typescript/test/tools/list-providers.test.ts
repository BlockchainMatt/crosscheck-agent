// Native-only behavior tests for runListProviders.

import { describe, expect, it } from "vitest";

import { runListProviders, __test_internals } from "../../src/tools/list-providers.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

const { KNOWN_PROVIDERS, USAGE_HINT } = __test_internals;

function stubProvider(name: string, model: string): Provider {
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: "", attempts: 1,
      usage: emptyUsage(name, model, args.purpose ?? "worker"),
    }),
  };
}

describe("runListProviders — defaults", () => {
  it("emits all KNOWN_PROVIDERS in stable order", () => {
    const r = runListProviders({}, {
      providers: { anthropic: stubProvider("anthropic", "claude") },
    }) as { providers: { name: string }[] };
    expect(r.providers.map((p) => p.name)).toEqual([...KNOWN_PROVIDERS]);
  });

  it("missing providers → available=false, model=null", () => {
    const r = runListProviders({}, { providers: {} }) as {
      providers: { name: string; available: boolean; model: string | null }[];
    };
    for (const p of r.providers) {
      expect(p.available).toBe(false);
      expect(p.model).toBeNull();
    }
  });

  it("active defaults to 'all available' when not specified", () => {
    const r = runListProviders({}, {
      providers: {
        anthropic: stubProvider("anthropic", "claude"),
        openai:    stubProvider("openai",    "gpt"),
      },
    }) as { providers: { name: string; active: boolean }[] };
    const byName: Record<string, boolean> = {};
    for (const p of r.providers) byName[p.name] = p.active;
    expect(byName["anthropic"]).toBe(true);
    expect(byName["openai"]).toBe(true);
    expect(byName["xai"]).toBe(false);
  });

  it("explicit activeProviders narrows the active set", () => {
    const r = runListProviders({}, {
      providers: {
        anthropic: stubProvider("anthropic", "claude"),
        openai:    stubProvider("openai",    "gpt"),
        xai:       stubProvider("xai",       "grok"),
      },
      activeProviders: ["anthropic"],
    }) as { providers: { name: string; active: boolean }[] };
    expect(r.providers.find((p) => p.name === "anthropic")!.active).toBe(true);
    expect(r.providers.find((p) => p.name === "openai")!.active).toBe(false);
    expect(r.providers.find((p) => p.name === "xai")!.active).toBe(false);
  });

  it("moderator_default defaults to 'anthropic'", () => {
    const r = runListProviders({}, { providers: {} }) as { moderator_default: string };
    expect(r.moderator_default).toBe("anthropic");
  });

  it("explicit moderatorDefault overrides", () => {
    const r = runListProviders({}, {
      providers: {}, moderatorDefault: "openai",
    }) as { moderator_default: string };
    expect(r.moderator_default).toBe("openai");
  });

  it("usage_hint is the stable Python string", () => {
    const r = runListProviders({}, { providers: {} }) as { usage_hint: string };
    expect(r.usage_hint).toBe(USAGE_HINT);
    expect(r.usage_hint).toContain("ad-hoc subset");
  });
});
