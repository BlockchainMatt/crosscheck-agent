// Cross-language parity: extractJson.
//
// Same input string → same parsed value (or null) on both sides.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { extractJson } from "../../src/core/extract-json.js";

interface Case {
  label:    string;
  text:     string;
  expected: unknown;
}
interface Fixture { module: string; case_count: number; cases: readonly Case[] }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "extract_json.json"), "utf8"),
) as Fixture;

describe(`extract_json parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, () => {
      const actual = extractJson(c.text);
      expect(canonicalize(actual)).toBe(canonicalize(c.expected));
    });
  }
});
