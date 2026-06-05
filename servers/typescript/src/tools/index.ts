// Tool registry. Native TS tools ported phase-by-phase land here; the
// rest of the surface is proxied through the Python bridge by the
// server's buildToolRegistry(). Native entries automatically shadow
// bridge proxies of the same name — that's the per-tool-cutover
// mechanism (see server.ts).
//
// Tools that need to defer to the bridge for advanced sub-features
// (e.g. verify's shell + url_head check kinds) take the bridge handle
// as a closure capture in their handler.

import { z } from "zod";

import type { BridgeHandle } from "../bridge/index.js";
import type { Provider } from "../providers/types.js";
import { SERVER_NAME, SERVER_VERSION } from "../server.js";
import { runAudit } from "./audit.js";
import { runConfer } from "./confer.js";
import { runPick } from "./pick.js";
import { runVerify } from "./verify.js";

/** A registered MCP tool. `inputSchema` is the JSON-Schema surfaced via
 *  tools/list; `handler` runs on tools/call. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Build a Tool from a Zod schema; the JSON-Schema is rendered once at
 *  registration time. */
export function defineTool<T>(opts: {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  handler: (args: T) => Promise<unknown>;
}): Tool {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: zodToJsonSchema(opts.schema),
    handler: async (raw: Record<string, unknown>) => {
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `${opts.name}: argument validation failed: ${parsed.error.message}`,
        );
      }
      return opts.handler(parsed.data);
    },
  };
}

/** Minimal Zod-to-JSON-Schema rendering — enough for ping. The full port
 *  will replace this with a richer converter (or hand-authored schemas
 *  matching the Python `schema/tools.schema.json`). */
function zodToJsonSchema(schema: z.ZodType<unknown>): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      if (!(val instanceof z.ZodOptional) && !(val instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    };
  }
  if (schema instanceof z.ZodString)  return { type: "string" };
  if (schema instanceof z.ZodNumber)  return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodDefault)  return zodToJsonSchema(schema._def.innerType);
  return {};
}

/** Options threaded into the tool registry. Lets the server pass
 *  native providers + the bridge (for sub-feature fallback) into
 *  individual tool handlers via closure capture. */
export interface RegisterCoreToolsOptions {
  /** Optional Python bridge for sub-feature deferral (verify's
   *  shell/url_head; future: tools-not-yet-native). */
  bridge?: BridgeHandle;
  /** Native LLM providers, keyed by lowercased name (e.g. "anthropic").
   *  When absent, LLM tools (pick, …) reject calls or — once cutover —
   *  fall back to the bridge. */
  providers?: Readonly<Record<string, Provider>>;
  /** Optional provider allowlist. null/undefined = no allowlist. */
  providerAllowlist?: readonly string[] | null;
}

/** Build the native tool surface. Returns a name -> Tool map.
 *
 *  Native entries take precedence over bridge proxies of the same name
 *  (see server.ts buildToolRegistry). */
export function registerCoreTools(
  opts: RegisterCoreToolsOptions | BridgeHandle = {},
): Map<string, Tool> {
  // Accept both the legacy single-arg `BridgeHandle` form and the new
  // options bag. Discriminate by the presence of `toolNames`.
  const o: RegisterCoreToolsOptions =
    opts && typeof opts === "object" && "toolNames" in opts
      ? { bridge: opts as BridgeHandle }
      : (opts as RegisterCoreToolsOptions);

  const tools = new Map<string, Tool>();
  const list: Tool[] = [
    pingTool(),
    verifyTool(o.bridge),
    pickTool(o.providers ?? {}, o.providerAllowlist ?? null),
    auditTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    conferTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
  ];
  for (const t of list) tools.set(t.name, t);
  return tools;
}

/** `confer` — native port of Python's tool_confer. v1 covers the
 *  plain panel-call path; opts (untrusted_input, extract_claims,
 *  early_stop, inject_session_memory, auto_panel, worker_tools) defer
 *  to the bridge when supplied. */
function conferTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "confer",
    description:
      "Ask a panel of LLM providers the same question; return one answer per " +
      "provider. v1 native covers the plain panel call; advanced opts " +
      "(untrusted_input, extract_claims, early_stop, inject_session_memory, " +
      "auto_panel, worker_tools) require the Python bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        question:   { type: "string" },
        context:    { type: "string" },
        providers:  { type: "array", items: { type: "string" } },
        session_id: { type: "string" },
        untrusted_input:        { type: "boolean" },
        extract_claims:         { type: "boolean" },
        early_stop:             { type: "boolean" },
        early_stop_threshold:   { type: "number" },
        inject_session_memory:  { type: "boolean" },
        auto_panel:             { type: "boolean" },
        auto_panel_n:           { type: "integer" },
        worker_tools:           { type: "array", items: { type: "string" } },
      },
      required: ["question"],
    },
    handler: (args) => runConfer(args, {
      providers,
      allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `audit` — native port of Python's tool_audit (single-mode).
 *  Coalesce-mode + session-id-only input defer to the bridge when
 *  available. */
function auditTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "audit",
    description:
      "Score a piece of output against an audit rubric. Single-judge by " +
      "default; coalesce-mode (multi-judge consensus) requires the Python " +
      "bridge in v1.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        output_to_audit:    { type: "string" },
        session_id:         { type: "string" },
        auditor:            { type: "string" },
        producing_panelists: { type: "array", items: { type: "string" } },
        rubric:             { type: "array", items: { type: "object" } },
        constraints:        { type: "string" },
        cheap_mode:         { type: "boolean" },
        allow_self_audit:   { type: "boolean" },
        coalesce:           { type: "boolean" },
        strict_mode:        { type: "boolean" },
        max_judges:         { type: "integer", minimum: 1 },
      },
    },
    handler: (args) => runAudit(args, {
      providers,
      allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `pick` — native port of Python's tool_pick. Closes over the
 *  available providers (and optional allowlist) so the handler can
 *  dispatch by name. */
function pickTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
): Tool {
  return {
    name: "pick",
    description:
      "Score a set of options across criteria using one or more LLM " +
      "providers, then rank by weighted-mean and surface dissent. " +
      "Deterministic given fixed provider outputs.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        decision: { type: "string" },
        options:  {
          type: "array", minItems: 2,
          items: {
            anyOf: [
              { type: "string" },
              { type: "object",
                properties: { name: { type: "string" },
                              description: { type: "string" } },
                required: ["name"] },
            ],
          },
        },
        criteria: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              weight: { type: "number" },
              description: { type: "string" },
            },
            required: ["name"],
          },
        },
        providers:           { type: "array", items: { type: "string" } },
        session_id:          { type: "string" },
        max_dissent_deltas:  { type: "integer", minimum: 1 },
      },
      required: ["decision", "options", "criteria"],
    },
    handler: (args) => runPick(args, { providers, allowlist }),
  };
}

/** `verify` — native port of Python's deterministic property-check
 *  tool. See src/tools/verify.ts for the surface contract.
 *
 *  We don't use defineTool() here because Python's tool_verify is
 *  permissive on input (returns an error ENVELOPE rather than throwing
 *  on bad shape), and we need byte-equal output. The hand-written JSON
 *  schema mirrors what the Python server documents. */
function verifyTool(bridge: BridgeHandle | undefined): Tool {
  return {
    name: "verify",
    description:
      "Run a list of deterministic property checks against caller-supplied data. " +
      "No LLM calls; everything is local. Returns per-check {passed, reason} plus " +
      "all_passed / summary / timing fields. Supports the text kinds (contains, " +
      "not_contains, regex_match, contains_any, contains_all, min_length); shell " +
      "and url_head kinds require the Python bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        checks: {
          type: "array",
          minItems: 1,
          items: { type: "object", additionalProperties: true },
        },
        session_id: { type: "string" },
        allow_shell: { type: "boolean" },
      },
      required: ["checks"],
    },
    handler: (args) => runVerify(args, bridge),
  };
}

/** `ping` — proves the MCP wire is live and returns the server's
 *  identity. Useful as a smoke test from any client; the Python parity
 *  tests will also call it. */
function pingTool(): Tool {
  return defineTool({
    name: "ping",
    description:
      "Bootstrap smoke test. Returns the server name + version + a caller-provided echo string. " +
      "Phase-0 placeholder; will remain available as the canonical liveness probe.",
    schema: z.object({
      echo: z.string().optional(),
    }),
    handler: async (args: { echo?: string }) => ({
      tool: "ping",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      pong: args.echo ?? "pong",
    }),
  });
}
