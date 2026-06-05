// Native TS port of Python's `tool_plan` — Phase 5 part 10.
//
// Tiny wrapper over `debate`: builds a structured "step-by-step plan
// for this goal under these constraints" prompt and runs the multi-
// round debate flow with whatever providers are configured.
//
// The output IS a debate envelope (tool: "debate") — Python doesn't
// rename it. Matching that exactly keeps the parity contract simple
// + avoids surprising callers who chain plan → audit / verify / etc.

import { runDebate, type RunDebateOptions } from "./debate.js";

export type RunPlanOptions = RunDebateOptions;

export async function runPlan(
  args: Record<string, unknown>,
  opts: RunPlanOptions,
): Promise<Record<string, unknown>> {
  const goal = typeof args["goal"] === "string"
    ? args["goal"]
    : String(args["goal"] ?? "");
  const constraints = typeof args["constraints"] === "string"
    ? args["constraints"]
    : "";

  // Byte-equal prompt with Python's f-string.
  const merged =
    "We need a step-by-step plan to achieve this goal.\n\n" +
    `GOAL: ${goal}\n\n` +
    `CONSTRAINTS: ${constraints || "(none stated)"}\n\n` +
    "Return: (1) the plan as numbered steps, (2) risks, (3) alternatives considered.";

  // Delegate to debate. Pass through providers/context/moderator/
  // session_id and the structured flag. Note: structured=true defers
  // to bridge (handled by runDebate).
  const debateArgs: Record<string, unknown> = {
    topic:       merged,
    context:     typeof args["context"] === "string" ? args["context"] : "",
    structured:  Boolean(args["structured"]),
  };
  if (args["providers"]  !== undefined) debateArgs["providers"]  = args["providers"];
  if (args["moderator"]  !== undefined) debateArgs["moderator"]  = args["moderator"];
  if (args["session_id"] !== undefined) debateArgs["session_id"] = args["session_id"];

  return await runDebate(debateArgs, opts);
}
