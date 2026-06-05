// Native-only behavior tests for runTriangulate.
//
// Cross-language parity is covered by test/parity/triangulate_tool.test.ts.

import { describe, expect, it } from "vitest";

import { runTriangulate } from "../../src/tools/triangulate.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

function panelistFromList(name: string, texts: string[]): Provider {
  let i = 0;
  return {
    name, model: `${name}-default`,
    send: async (args: SendArgs): Promise<SendResult> => {
      const text = i < texts.length ? texts[i]! : "";
      i++;
      return { text, attempts: 1,
               usage: emptyUsage(name, `${name}-default`, args.purpose ?? "worker") };
    },
  };
}

const PROP_OK =
  '{"role":"proposer","summary":"Adopt rust.","confidence":0.85,'
  + '"ballot":"agree","claims":[{"claim":"safer","confidence":0.9}],"citations":[]}';
const CRIT_OK =
  '{"role":"critic","summary":"Slow ramp.","confidence":0.65,'
  + '"ballot":"disagree","claims":[],"citations":[]}';
const SYNTH_WITH_DISSENT =
  '{"consensus":"Adopt rust gradually.","weighted_confidence":0.75,'
  + '"key_claims":[{"claim":"safer","confidence":0.85}],'
  + '"dissent":[{"claim":"slow ramp","providers":["b"],"rationale":"team cost"}],'
  + '"citations":[],"open_questions":["Who trains?"]}';

describe("runTriangulate — wraps coordinate envelope", () => {
  it("reshapes synthesis_structured into top-level fields", async () => {
    const a = panelistFromList("a", [PROP_OK, SYNTH_WITH_DISSENT]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "rust?" },
      { providers: { a, b } },
    ) as {
      tool: string; question: string;
      consensus: string; weighted_confidence: number;
      key_claims: { claim: string }[];
      dissent: { claim: string; providers: string[] }[];
      open_questions: string[];
      minority_report: string;
      panel: { provider: string; weight: number }[];
      providers_used: string[];
      roles: { proposer: string; critics: string[]; synthesizer: string };
      synthesis_errors: string[];
    };
    expect(r.tool).toBe("triangulate");
    expect(r.question).toBe("rust?");
    expect(r.consensus).toBe("Adopt rust gradually.");
    expect(r.weighted_confidence).toBeCloseTo(0.75);
    expect(r.key_claims).toHaveLength(1);
    expect(r.dissent).toHaveLength(1);
    expect(r.open_questions).toEqual(["Who trains?"]);
    expect(r.providers_used).toEqual(["a", "b"]);
    expect(r.panel).toEqual([
      { provider: "a", weight: 1.0 },
      { provider: "b", weight: 1.0 },
    ]);
    // Synthesizer falls back to proposer (a) since no moderator was
    // configured AND "anthropic" isn't in this 2-provider panel.
    expect(r.roles).toEqual({ proposer: "a", critics: ["b"], synthesizer: "a" });
  });

  it("minority_report formatted from dissent", async () => {
    const a = panelistFromList("a", [PROP_OK, SYNTH_WITH_DISSENT]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "x" },
      { providers: { a, b } },
    ) as { minority_report: string };
    expect(r.minority_report).toBe("- slow ramp — voiced by b: team cost");
  });

  it("no dissent → '(no dissent recorded)'", async () => {
    const a = panelistFromList("a", [
      PROP_OK,
      '{"consensus":"go","weighted_confidence":0.9,"key_claims":[],"dissent":[]}',
    ]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "x" },
      { providers: { a, b } },
    ) as { minority_report: string; dissent: unknown[] };
    expect(r.dissent).toEqual([]);
    expect(r.minority_report).toBe("(no dissent recorded)");
  });

  it("missing synthesis_structured → '(no consensus produced)'", async () => {
    // Synth returns malformed JSON → structured = null → consensus
    // defaults.
    const a = panelistFromList("a", [PROP_OK, "not JSON"]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "x" },
      { providers: { a, b } },
    ) as { consensus: string; weighted_confidence: unknown };
    expect(r.consensus).toBe("(no consensus produced)");
    expect(r.weighted_confidence).toBeNull();
  });

  it("dissent with no providers → '(unspecified)' label", async () => {
    const SYNTH_UNSPEC =
      '{"consensus":"go","weighted_confidence":0.5,"key_claims":[],'
      + '"dissent":[{"claim":"maybe not","providers":[]}]}';
    const a = panelistFromList("a", [PROP_OK, SYNTH_UNSPEC]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "x" },
      { providers: { a, b } },
    ) as { minority_report: string };
    expect(r.minority_report).toBe("- maybe not — voiced by (unspecified)");
  });

  it("coordinate error → returned verbatim", async () => {
    // Only 1 provider → coordinate emits error envelope; triangulate
    // returns it as-is.
    const r = await runTriangulate(
      { question: "x", providers: ["a"] },
      { providers: { a: panelistFromList("a", []) } },
    ) as { error: string; tool?: string };
    expect(r.error).toContain("at least 2 providers");
    // Triangulate does not overwrite tool="triangulate" on error
    // passthrough — it just returns coord verbatim (Python parity).
    expect(r.tool).toBe("coordinate");
  });

  it("panel is sorted + deduped", async () => {
    // Same provider as both proposer and synthesizer (default behavior
    // when moderator='anthropic' which isn't in panel → falls back to
    // proposer). Both anthropic-role entries should dedupe to one
    // panel entry.
    const a = panelistFromList("a", [PROP_OK, SYNTH_WITH_DISSENT]);
    const b = panelistFromList("b", [CRIT_OK]);
    const r = await runTriangulate(
      { question: "x" },
      { providers: { a, b } },
    ) as { panel: { provider: string }[] };
    expect(r.panel.map((p) => p.provider)).toEqual(["a", "b"]);
  });
});
