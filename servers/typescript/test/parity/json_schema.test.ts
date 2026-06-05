// Cross-language parity: validateSchema (Python's _validate).
//
// Same (value, schema) → same list[str] of errors. We assert byte-equal
// on the canonicalized list — the error strings themselves (including
// f"…{v!r}…" interpolations) are part of the contract.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { validateSchema } from "../../src/core/json-schema.js";

interface Case {
  label:           string;
  value:           unknown;
  schema:          Record<string, unknown>;
  expected_errors: string[];
}
interface Fixture { module: string; case_count: number; cases: readonly Case[] }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "json_schema.json"), "utf8"),
) as Fixture;

describe(`json_schema parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, () => {
      const actual = validateSchema(c.value, c.schema);
      expect(canonicalize(actual)).toBe(canonicalize(c.expected_errors));
    });
  }
});
