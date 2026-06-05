// Native TS port of Python's `tool_review` — Phase 5 part 12.
//
// Tiny wrapper over `confer`. Builds an "INTENT + SNIPPET" prompt
// asking the panel to review code/proposal as peers. Output IS a
// confer envelope (tool: "confer") — matches Python which doesn't
// rename. Lets downstream chains (review → audit → verify) see a
// confer-shaped result.

import { runConfer, type RunConferOptions } from "./confer.js";

export type RunReviewOptions = RunConferOptions;

export async function runReview(
  args: Record<string, unknown>,
  opts: RunReviewOptions,
): Promise<Record<string, unknown>> {
  const snippet = typeof args["snippet"] === "string"
    ? args["snippet"]
    : String(args["snippet"] ?? "");
  const intent = typeof args["intent"] === "string" ? args["intent"] : "";

  // Byte-equal with Python's f-string.
  const question =
    "Review the following code/proposal as peers. Call out bugs, smells, " +
    "missed edge cases, and suggest concrete changes.\n\n" +
    `INTENT: ${intent || "(not stated)"}\n\n` +
    `SNIPPET:\n\`\`\`\n${snippet}\n\`\`\``;

  const conferArgs: Record<string, unknown> = {
    question,
    untrusted_input: Boolean(args["untrusted_input"]),
  };
  if (args["providers"]  !== undefined) conferArgs["providers"]  = args["providers"];
  if (args["session_id"] !== undefined) conferArgs["session_id"] = args["session_id"];

  return await runConfer(conferArgs, opts);
}
