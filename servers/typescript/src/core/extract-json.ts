// Extract a JSON object (or array) from free-form provider text.
//
// LLM outputs aren't reliably bare JSON — providers add markdown fences,
// prose preambles ("Sure, here's the JSON: …"), or trailing newlines.
// This helper mirrors Python's `_extract_json` strategy:
//
//   1. Try a direct JSON.parse. If the model behaved, we're done.
//   2. Look for a ```json ... ``` fenced block.
//   3. Walk the string for the first balanced {...} or [...] block,
//      respecting quoted-string escape sequences so braces inside
//      strings don't fool the depth counter.
//
// Returns the parsed value, or `null` if nothing valid was found. Pure
// function — no I/O.

/** Pull a JSON object/array from free text. Tolerates markdown fences
 *  and prose around the payload. Returns null when no parseable block
 *  is found. */
export function extractJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (s.length === 0) return null;

  // 1. Direct parse.
  try { return JSON.parse(s); } catch { /* try next strategy */ }

  // 2. Fenced markdown block: ```json\n…\n``` or ```\n…\n```
  const fence = /```(?:json)?\s*\n(.*?)\n```/is.exec(s);
  if (fence) {
    try { return JSON.parse(fence[1] ?? ""); } catch { /* try next strategy */ }
  }

  // 3. First balanced {…} or […]. We respect quoted-string escapes so
  //    braces inside JSON strings don't mislead the depth counter.
  for (const [opener, closer] of [["{", "}"], ["[", "]"]] as const) {
    const start = s.indexOf(opener);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc   = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i]!;
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  return null;
}
