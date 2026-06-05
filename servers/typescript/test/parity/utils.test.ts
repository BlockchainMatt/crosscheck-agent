// Cross-language parity: small utility helpers.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  checkDagBreakers,
  checkSessionBreakers,
  classifyHttpError,
  perCallTokens,
  projectSessionWithAnswers,
  safeSessionId,
  type BreakerCfg,
  type DagShape,
  type SessionRowSnapshot,
} from "../../src/core/utils.js";

interface Fixture {
  module: string;
  sid_cases: readonly { label: string; input: string; expected: string }[];
  per_call_cases: readonly {
    label: string;
    calls: number;
    cfg: { token_cap?: unknown } | null;
    expected: number;
  }[];
  http_cases: readonly {
    label: string;
    status: number;
    body: string;
    retry_after: number | null;
    expected: {
      kind: string;
      transient: boolean;
      status: number;
      message: string;
      retry_after_s: number | null;
    };
  }[];
  breaker_cases: readonly {
    label: string;
    session: SessionRowSnapshot | null;
    cfg: BreakerCfg;
    expected: { name: string; reason: string } | null;
  }[];
  dag_cases: readonly {
    label: string;
    dag: DagShape;
    cfg: BreakerCfg;
    expected: { name: string; reason: string } | null;
  }[];
  project_cases: readonly {
    label: string;
    session: SessionRowSnapshot | null;
    extras: readonly {
      usage?: { cost_usd?: number; total_tokens?: number };
      elapsed_ms?: number;
    }[];
    expected: SessionRowSnapshot | null;
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/utils.json", import.meta.url), "utf8"),
) as Fixture;

describe("parity: utils", () => {
  it("fixture loaded", () => {
    expect(fixture.module).toBe("utils");
  });

  it.each(fixture.sid_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(safeSessionId(c.input)).toBe(c.expected);
    },
  );

  it.each(fixture.per_call_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(perCallTokens(c.calls, c.cfg ?? undefined)).toBe(c.expected);
    },
  );

  it.each(fixture.http_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      const r = classifyHttpError({
        status: c.status,
        body: c.body,
        retryAfterHeader: c.retry_after !== null ? String(c.retry_after) : null,
      });
      expect(r).toEqual(c.expected);
    },
  );

  it.each(fixture.breaker_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(checkSessionBreakers(c.session, c.cfg)).toEqual(c.expected);
    },
  );

  it.each(fixture.dag_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(checkDagBreakers(c.dag, c.cfg)).toEqual(c.expected);
    },
  );

  it.each(fixture.project_cases.map((c) => [c.label, c] as const))(
    "%s",
    (_label, c) => {
      expect(projectSessionWithAnswers(c.session, c.extras)).toEqual(c.expected);
    },
  );
});
