// Cross-language parity: native tool_list_providers.
//
// CFG.providers (active set) and CFG.moderator (moderator default)
// are env-dependent on the recording box, so the fixture builder
// patches both to controlled values. The TS test rebuilds the same
// controlled providers map + activeProviders + moderatorDefault.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/core/canonicalize.js";
import { runListProviders } from "../../src/tools/list-providers.js";
import { emptyUsage } from "../../src/core/usage.js";

import type { Provider, SendArgs, SendResult } from "../../src/providers/types.js";

interface ListProvidersCase {
  label:                string;
  available_providers:  string[];
  active_providers:     string[];
  moderator_default:    string;
  provider_models:      Record<string, string>;
  expected:             Record<string, unknown>;
}
interface Fixture {
  module: string;
  case_count: number;
  cases: readonly ListProvidersCase[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.resolve(HERE, "fixtures", "list_providers_tool.json"), "utf8"),
) as Fixture;

function stubProvider(name: string, model: string): Provider {
  return {
    name, model,
    send: async (args: SendArgs): Promise<SendResult> => ({
      text: "", attempts: 1,
      usage: emptyUsage(name, model, args.purpose ?? "worker"),
    }),
  };
}

describe(`list_providers parity (${fixture.case_count} cases)`, () => {
  for (const c of fixture.cases) {
    it(c.label, () => {
      const providers: Record<string, Provider> = {};
      for (const name of c.available_providers) {
        const model = c.provider_models[name] ?? `${name}-default`;
        providers[name] = stubProvider(name, model);
      }
      const actual = runListProviders({}, {
        providers,
        activeProviders:   c.active_providers,
        moderatorDefault:  c.moderator_default,
      });
      expect(canonicalize(actual)).toBe(canonicalize(c.expected));
    });
  }
});
