// Cross-language parity: redactText + redactObj.
//
// Plain mode is fully deterministic. HMAC mode uses a fixed secret +
// session_id baked into the fixture so the suffixes match Python's
// derivation byte-for-byte.

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { redactObj, redactText, type RedactionConfig } from "../../src/core/redact.js";

interface BaseCase {
  label: string;
  input: unknown;
  config: {
    enabled: boolean;
    hmac_tokens: boolean;
    session_id?: string;
    secret_hex?: string;
  };
  expected: unknown;
}

interface Fixture {
  module: string;
  case_count: number;
  secret_hex: string;
  session_id: string;
  plain_cases: readonly BaseCase[];
  hmac_cases: readonly BaseCase[];
  disabled_cases: readonly BaseCase[];
  obj_cases: readonly BaseCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/redact.json", import.meta.url), "utf8"),
) as Fixture;

function configFor(raw: BaseCase["config"]): RedactionConfig {
  const cfg: RedactionConfig = {
    enabled: raw.enabled,
    hmac_tokens: raw.hmac_tokens,
  };
  if (raw.secret_hex) cfg.hmac_secret = Buffer.from(raw.secret_hex, "hex");
  if (raw.session_id) cfg.session_id = raw.session_id;
  return cfg;
}

describe(`parity: redact (${fixture.case_count} cases)`, () => {
  it("fixture loaded with embedded secret", () => {
    expect(fixture.module).toBe("redact");
    expect(fixture.secret_hex.length).toBe(64); // 32 bytes
  });

  it.each(fixture.plain_cases.map((c) => [c.label, c] as const))(
    "plain :: %s",
    (_label, c) => {
      expect(redactText(c.input, configFor(c.config))).toBe(c.expected);
    },
  );

  it.each(fixture.hmac_cases.map((c) => [c.label, c] as const))(
    "hmac :: %s",
    (_label, c) => {
      expect(redactText(c.input, configFor(c.config))).toBe(c.expected);
    },
  );

  it.each(fixture.disabled_cases.map((c) => [c.label, c] as const))(
    "disabled :: %s",
    (_label, c) => {
      expect(redactText(c.input, configFor(c.config))).toBe(c.expected);
    },
  );

  it.each(fixture.obj_cases.map((c) => [c.label, c] as const))(
    "obj :: %s",
    (_label, c) => {
      expect(redactObj(c.input, configFor(c.config))).toEqual(c.expected);
    },
  );
});
