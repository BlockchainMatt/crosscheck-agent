// Tool registry. Phase 0 ships ONE tool — `ping`. Subsequent phases will
// register the full surface (confer, debate, plan, ...). Keeping the
// shape generic from day one so we don't refactor it later.

import { z } from "zod";

import { SERVER_NAME, SERVER_VERSION } from "../server.js";

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

/** Build the Phase-0 tool surface. Returns a name -> Tool map. */
export function registerCoreTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const list: Tool[] = [pingTool()];
  for (const t of list) tools.set(t.name, t);
  return tools;
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
