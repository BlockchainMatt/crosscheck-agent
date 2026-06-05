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
import { runCoordinate } from "./coordinate.js";
import { runCritique } from "./critique.js";
import { runDebate } from "./debate.js";
import { runDelegate } from "./delegate.js";
import { runExplain } from "./explain.js";
import { runFetch, type FetchConfig } from "./fetch.js";
import { runListProviders } from "./list-providers.js";
import { runPick } from "./pick.js";
import { runPlan } from "./plan.js";
import { runRecall } from "./recall.js";
import { runRecommendPanel } from "./recommend-panel.js";
import { runReview } from "./review.js";
import { runScoreboard } from "./scoreboard.js";
import { runSessionMemory } from "./session-memory.js";
import { runUpdateCrosscheck } from "./update-crosscheck.js";
import { runTriangulate } from "./triangulate.js";
import { runVerify } from "./verify.js";

import type { Storage } from "../adapters/storage/interface.js";

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
  /** Providers CFG considers active. Used by list_providers to
   *  populate the `active` flag. When null/undefined, defaults to
   *  "all available". */
  activeProviders?: readonly string[] | null;
  /** Moderator default. Matches Python CFG.moderator; defaults to
   *  "anthropic". Used by list_providers + audit + debate + coordinate. */
  moderatorDefault?: string;
  /** SQLite-backed storage adapter. When supplied, storage-driven
   *  tools (recall, scoreboard, session_memory, explain) run natively.
   *  When absent, they defer to the bridge (or return an error). */
  storage?: Storage;
  /** Path to the events.jsonl file used by scoreboard's
   *  `recent_events` tail. When unset, that field is always empty. */
  eventsPath?: string;
  /** Directory holding transcript JSON files (used by `explain` to
   *  walk per-session transcripts). When unset, the transcripts
   *  list is empty (matches Python's "dir missing"). */
  transcriptsDir?: string;
  /** Repo root for path-emission in `fetch`'s evidence + the
   *  evidence dir resolver. When unset, paths are absolute. */
  repoRoot?: string;
  /** CFG.fetch config. */
  fetchConfig?: FetchConfig;
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
    debateTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    coordinateTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    triangulateTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    planTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    critiqueTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    reviewTool(o.providers ?? {}, o.providerAllowlist ?? null, o.bridge),
    listProvidersTool(o.providers ?? {}, o.activeProviders ?? null, o.moderatorDefault ?? "anthropic"),
    recallTool(o.storage, o.bridge),
    sessionMemoryTool(o.storage, o.bridge),
    scoreboardTool(o.storage, o.bridge, o.eventsPath),
    explainTool(o.storage, o.bridge, o.transcriptsDir),
    delegateTool(o.providers ?? {}, o.providerAllowlist ?? null,
                 o.storage, o.bridge, o.moderatorDefault ?? "anthropic"),
    fetchTool(o.storage, o.fetchConfig, o.repoRoot),
    recommendPanelTool(o.providers ?? {}, o.storage, o.bridge),
    updateCrosscheckTool(o.repoRoot ?? null),
  ];
  for (const t of list) tools.set(t.name, t);
  return tools;
}

/** `update_crosscheck` — native port of Python's
 *  tool_update_crosscheck. Compares local git HEAD to remote GitHub
 *  `main` HEAD and reports the relationship. With apply=true,
 *  fast-forwards via `git pull --ff-only`. Requires a wired repoRoot. */
function updateCrosscheckTool(
  repoRoot: string | null,
): Tool {
  return {
    name: "update_crosscheck",
    description:
      "Compare local git HEAD to remote GitHub main HEAD and report the " +
      "relationship (equal / ahead / behind / diverged / unknown). " +
      "With apply=true, fast-forwards via git pull --ff-only when " +
      "the local is strictly behind. Restart of the MCP connection is " +
      "required after a successful update.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        apply: { type: "boolean" },
      },
    },
    handler: async (args) => {
      if (!repoRoot) {
        return {
          tool: "update_crosscheck", status: "error",
          reason: "could not determine repo root; the entrypoint did not " +
                  "supply a repoRoot. crosscheck-agent must be installed " +
                  "as a git checkout for in-place updates.",
          remote_url: "https://github.com/fxspeiser/crosscheck-agent",
        };
      }
      return runUpdateCrosscheck(args, { repoRoot });
    },
  };
}

/** `recommend_panel` — native port of Python's tool_recommend_panel.
 *  Pulls usage stats + provider weights from Storage and delegates
 *  the scoring + cold-start logic to the Phase-2-ported routerRecommend. */
function recommendPanelTool(
  providers: Readonly<Record<string, Provider>>,
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "recommend_panel",
    description:
      "Recommend a minimal effective panel for a given purpose, based " +
      "on historical usage_log + provider_stats. Cold-start falls back " +
      "to the configured panel ordered by win-rate.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        purpose:        { type: "string" },
        n:              { type: "integer", minimum: 1 },
        exclude:        { type: "array", items: { type: "string" } },
        since_days:     { type: "integer", minimum: 0 },
        available_only: { type: "boolean" },
      },
      required: ["purpose"],
    },
    handler: (args) => runRecommendPanel(args, {
      providers,
      ...(storage ? { storage } : {}),
      ...(bridge  ? { bridge }  : {}),
    }),
  };
}

/** `fetch` — native port of Python's tool_fetch. HTTP retrieval with
 *  allowlist gating, per-session egress budget, sha256-content-
 *  addressed evidence storage. Storage is optional (caps degrade to
 *  unlimited without it). */
function fetchTool(
  storage: Storage | undefined,
  fetchConfig: FetchConfig | undefined,
  repoRoot: string | undefined,
): Tool {
  return {
    name: "fetch",
    description:
      "HTTP retrieval with url_allowlist + per-session egress caps + " +
      "sha256-content-addressed evidence storage. Returns the cached " +
      "meta when the URL has been fetched before (override with " +
      "force_refresh=true).",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        url:           { type: "string" },
        force_refresh: { type: "boolean" },
        session_id:    { type: "string" },
      },
      required: ["url"],
    },
    handler: (args) => runFetch(args, {
      ...(storage     ? { storage }     : {}),
      ...(fetchConfig ? { config: fetchConfig } : {}),
      ...(repoRoot    ? { repoRoot }    : {}),
    }),
  };
}

/** `delegate` — native port of Python's tool_delegate. Quota-gated
 *  single-provider dispatch to confer / review. Requires Storage. */
function delegateTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
  moderator: string,
): Tool {
  return {
    name: "delegate",
    description:
      "Run a delegable tool (confer | review) restricted to a single " +
      "named provider, with explicit quota check. Records every attempt " +
      "(accepted or refused) to the delegations table; quota in the " +
      "response reflects counts AFTER the current call.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        tool_call:    { type: "string", enum: ["confer", "review"] },
        via:          { type: "string" },
        args:         { type: "object", additionalProperties: true },
        requested_by: { type: "string" },
        session_id:   { type: "string" },
      },
      required: ["tool_call", "via"],
    },
    handler: (args) => runDelegate(args, {
      providers, allowlist, moderator,
      ...(storage ? { storage } : {}),
      ...(bridge  ? { bridge }  : {}),
    }),
  };
}

/** `explain` — native port of Python's tool_explain. Session replay
 *  + cost/latency tree. Requires Storage; optionally reads a
 *  transcripts directory for the per-tool summary block. */
function explainTool(
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
  transcriptsDir: string | undefined,
): Tool {
  return {
    name: "explain",
    description:
      "Replay a session as a navigable tree with cost/latency " +
      "annotations. Reads usage_log + optionally walks the " +
      "transcripts directory for per-tool summaries.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        session_id:      { type: "string" },
        include_text:    { type: "boolean" },
        max_transcripts: { type: "integer", minimum: 1 },
        only_purpose:    { type: "array", items: { type: "string" } },
        only_provider:   { type: "array", items: { type: "string" } },
      },
      required: ["session_id"],
    },
    handler: (args) => runExplain(args, {
      ...(storage        ? { storage }        : {}),
      ...(bridge         ? { bridge }         : {}),
      ...(transcriptsDir ? { transcriptsDir } : {}),
    }),
  };
}

/** `scoreboard` — native port of Python's tool_scoreboard. Aggregates
 *  ballot stats + delegation counts + table totals across the whole
 *  DB. Optionally tails an events.jsonl file for `recent_events`. */
function scoreboardTool(
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
  eventsPath: string | undefined,
): Tool {
  return {
    name: "scoreboard",
    description:
      "Aggregate provider ballot stats + delegation counts + table " +
      "totals. Supports top_k (rank limit) and recent_limit (tail of " +
      "events.jsonl when configured). Requires a wired Storage " +
      "adapter; falls back to the Python bridge when not available.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        top_k:        { type: "integer", minimum: 1 },
        recent_limit: { type: "integer", minimum: 0 },
      },
    },
    handler: (args) => runScoreboard(args, {
      ...(storage     ? { storage }     : {}),
      ...(bridge      ? { bridge }      : {}),
      ...(eventsPath  ? { eventsPath }  : {}),
    }),
  };
}

/** `session_memory` — native port of Python's tool_session_memory.
 *  CRUD over the per-session working memory ledger. Requires Storage. */
function sessionMemoryTool(
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "session_memory",
    description:
      "CRUD over the per-session working memory ledger. Actions: list, " +
      "add, mark_stale, clear. Requires a wired Storage adapter; falls " +
      "back to the Python bridge when not available.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        action:        { type: "string", enum: ["list", "add", "mark_stale", "clear"] },
        session_id:    { type: "string" },
        kinds:         { type: "array", items: { type: "string" } },
        include_stale: { type: "boolean" },
        limit:         { type: "integer", minimum: 1 },
        kind:          { type: "string", enum: ["fact", "open_question", "decision"] },
        content:       { type: "string" },
        source_tool:   { type: "string" },
        confidence:    { type: "number" },
        ids:           { type: "array", items: { type: "integer" } },
        reason:        { type: "string" },
      },
      required: ["action", "session_id"],
    },
    handler: (args) => runSessionMemory(args, {
      ...(storage ? { storage } : {}),
      ...(bridge  ? { bridge  } : {}),
    }),
  };
}

/** `recall` — native port of Python's tool_recall. FTS5 search over
 *  persisted transcripts. Requires a Storage adapter; defers to
 *  bridge when not wired. */
function recallTool(
  storage: Storage | undefined,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "recall",
    description:
      "Full-text search across persisted transcripts via SQLite FTS5. " +
      "Returns rows ordered by relevance with a windowed snippet. " +
      "Requires a wired Storage adapter; falls back to the Python " +
      "bridge when not available.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        query:      { type: "string" },
        k:          { type: "integer", minimum: 1, maximum: 50 },
        session_id: { type: "string" },
        tool:       { type: "string" },
        since_days: { type: "number", minimum: 0 },
      },
      required: ["query"],
    },
    handler: (args) => runRecall(args, {
      ...(storage ? { storage } : {}),
      ...(bridge  ? { bridge  } : {}),
    }),
  };
}

/** `list_providers` — native port of Python's tool_list_providers.
 *  Returns the static provider catalog + active set + moderator default. */
function listProvidersTool(
  providers: Readonly<Record<string, Provider>>,
  activeProviders: readonly string[] | null,
  moderatorDefault: string,
): Tool {
  return {
    name: "list_providers",
    description:
      "Return every provider the server knows about and its status " +
      "(available / active / model). Includes the moderator default " +
      "and a usage hint for the ad-hoc 'providers' override.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    handler: async (args) => runListProviders(args, {
      providers,
      activeProviders,
      moderatorDefault,
    }),
  };
}

/** `review` — native port of Python's tool_review. Tiny wrapper over
 *  confer that asks the panel to peer-review a code/proposal snippet.
 *  Output IS a confer envelope (tool: "confer") — matches Python. */
function reviewTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "review",
    description:
      "Have an LLM panel peer-review a code or proposal snippet. " +
      "Returns the confer envelope (one answer per provider).",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        snippet:    { type: "string" },
        intent:     { type: "string" },
        providers:  { type: "array", items: { type: "string" } },
        session_id: { type: "string" },
        untrusted_input: { type: "boolean" },
      },
      required: ["snippet"],
    },
    handler: (args) => runReview(args, {
      providers, allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `critique` — native port of Python's tool_critique. Each panelist
 *  lists weaknesses of a proposal via structured-output; results
 *  merged + sorted by severity. v1 defers untrusted_input to bridge. */
function critiqueTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "critique",
    description:
      "Have each LLM panelist list the top weaknesses of a proposed " +
      "answer or approach (severity-rated). Returns per-provider " +
      "weakness lists + a merged list ordered by severity.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        proposal:        { type: "string" },
        question:        { type: "string" },
        providers:       { type: "array", items: { type: "string" } },
        max_per_provider: { type: "integer", minimum: 1 },
        session_id:      { type: "string" },
        untrusted_input: { type: "boolean" },
      },
      required: ["proposal"],
    },
    handler: (args) => runCritique(args, {
      providers, allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `plan` — native port of Python's tool_plan. Thin wrapper over
 *  debate that builds a "step-by-step plan + risks + alternatives"
 *  prompt. Output envelope is debate's (tool: "debate") — matches
 *  Python which doesn't rename. */
function planTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "plan",
    description:
      "Have an LLM panel debate a step-by-step plan for the stated goal " +
      "under the given constraints. Returns the debate envelope with a " +
      "moderator-synthesised plan. Use `structured: true` (bridge) for " +
      "schema-validated synthesis.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        goal:        { type: "string" },
        constraints: { type: "string" },
        context:     { type: "string" },
        providers:   { type: "array", items: { type: "string" } },
        moderator:   { type: "string" },
        session_id:  { type: "string" },
        structured:  { type: "boolean" },
      },
      required: ["goal"],
    },
    handler: (args) => runPlan(args, {
      providers, allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `triangulate` — native port of Python's tool_triangulate. Thin
 *  wrapper over coordinate that reshapes the output as consensus +
 *  minority report. */
function triangulateTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "triangulate",
    description:
      "Run a coordinate flow and reshape the output as a consensus + " +
      "minority report with per-provider weights. v1 uses 1.0 weights " +
      "(matches a fresh provider_stats DB); future versions thread " +
      "real win-rate weights when the DB layer ports.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        question:    { type: "string" },
        context:     { type: "string" },
        providers:   { type: "array", items: { type: "string" } },
        session_id:  { type: "string" },
        untrusted_input: { type: "boolean" },
      },
      required: ["question"],
    },
    handler: (args) => runTriangulate(args, {
      providers, allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `coordinate` — native port of Python's tool_coordinate. Three-role
 *  orchestration: proposer → critics → synthesizer with structured
 *  output at every step. Defers to bridge on the deferred opts. */
function coordinateTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "coordinate",
    description:
      "Run a three-role coordination flow (proposer → critics → synthesizer) " +
      "with structured output at every step. v1 native covers the plain " +
      "path; advanced opts (untrusted_input, inject_session_memory, " +
      "worker_tools) require the Python bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        topic:        { type: "string" },
        context:      { type: "string" },
        providers:    { type: "array", items: { type: "string" } },
        proposer:     { type: "string" },
        synthesizer:  { type: "string" },
        moderator:    { type: "string" },
        critics:      { type: "array", items: { type: "string" } },
        session_id:   { type: "string" },
        untrusted_input:       { type: "boolean" },
        inject_session_memory: { type: "boolean" },
        worker_tools:          { type: "array", items: { type: "string" } },
      },
      required: ["topic"],
    },
    handler: (args) => runCoordinate(args, {
      providers, allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
}

/** `debate` — native port of Python's tool_debate. v1 covers the
 *  plain N-round + plain moderator synthesis path; opts (auto_panel,
 *  structured, extract_claims, early_stop, inject_session_memory,
 *  worker_tools) defer to the bridge when supplied. */
function debateTool(
  providers: Readonly<Record<string, Provider>>,
  allowlist: readonly string[] | null,
  bridge: BridgeHandle | undefined,
): Tool {
  return {
    name: "debate",
    description:
      "Run a multi-round debate between LLM providers and synthesise the " +
      "result via a moderator. v1 native covers plain rounds + plain " +
      "synthesis; advanced opts (structured synthesis, early_stop, etc.) " +
      "require the Python bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        topic:        { type: "string" },
        context:      { type: "string" },
        max_rounds:   { type: "integer", minimum: 1 },
        providers:    { type: "array", items: { type: "string" } },
        moderator:    { type: "string" },
        session_id:   { type: "string" },
        structured:           { type: "boolean" },
        extract_claims:       { type: "boolean" },
        early_stop:           { type: "boolean" },
        early_stop_threshold: { type: "number" },
        auto_panel:           { type: "boolean" },
        auto_panel_n:         { type: "integer" },
        inject_session_memory: { type: "boolean" },
        worker_tools:         { type: "array", items: { type: "string" } },
      },
      required: ["topic"],
    },
    handler: (args) => runDebate(args, {
      providers,
      allowlist,
      ...(bridge ? { bridge } : {}),
    }),
  };
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
