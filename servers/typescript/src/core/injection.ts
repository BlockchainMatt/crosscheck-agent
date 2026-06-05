// Light defense against prompt-injection in untrusted text. Mirrors
// `_INJECTION_PHRASES` + `_neutralize_injection` in
// `servers/python/crosscheck_server.py` exactly.
//
// The regex catches the most common "you are now X" / "ignore previous
// instructions" / "system prompt:" shapes. It's not bulletproof — the
// belt-and-suspenders pair is `_wrap_untrusted` (canary detection) +
// canary leak scanning after dispatch.

/** Source-of-truth regex. Update both this and the Python mirror in
 *  lockstep. The TS port intentionally uses the SAME alternation order
 *  and the SAME case-insensitive flag so substitution behavior matches. */
export const INJECTION_PHRASES_RE = new RegExp(
  "\\b(" +
    "(?:ignore|disregard|forget)\\s+(?:all\\s+)?(?:previous\\s+|prior\\s+|the\\s+(?:above\\s+)?)?" +
    "(?:instructions|directions|prompts|rules|context)" +
    "|you are now\\b" +
    "|act as (?:a |an )?(?:[A-Za-z]+)" +
    "|pretend (?:to be|you are)" +
    "|system prompt:?" +
    "|new instructions:?" +
  ")",
  "gi",
);

/** Replace every match with the literal token `[neutralized]`. Non-string
 *  inputs pass through unchanged. */
export function neutralizeInjection(s: unknown): string {
  if (typeof s !== "string") return s as string;
  // Reset lastIndex defensively — INJECTION_PHRASES_RE is shared.
  INJECTION_PHRASES_RE.lastIndex = 0;
  return s.replace(INJECTION_PHRASES_RE, "[neutralized]");
}
