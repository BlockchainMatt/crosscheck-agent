// Python-style repr() helpers, used wherever the TS port has to emit
// strings that are byte-equal with Python's `f"…{x!r}…"` interpolations
// or `str([…])` list-format output.
//
// Why this exists: cross-language parity. A handful of tools (verify,
// audit, tiers, …) build user-visible reason strings that include the
// value being checked. Python prints those values via `repr()`; if the
// TS port uses JSON.stringify or anything else, the bytes diverge and
// the parity tests fail.
//
// All functions here are PURE — no I/O, no side effects.

/** Python's `repr(str)` for a single string.
 *
 *  Rules (from CPython's stringobject implementation):
 *    1. Quote choice — single quote `'…'` by default. If the string
 *       contains a single quote but no double quote, switch to double
 *       quotes so we don't have to escape.
 *    2. Inside the chosen quote, escape: the quote itself, backslash,
 *       newline (\n), carriage return (\r), tab (\t), and any other
 *       non-printable in ASCII as \xNN. Non-ASCII printable code points
 *       are emitted verbatim (Python 3 repr does not \uXXXX-escape
 *       printable Unicode).
 *
 *  This is enough for the parity surface — the strings that flow
 *  through verify/audit reason messages are all simple ASCII or simple
 *  Unicode.
 */
export function pyStrRepr(s: string): string {
  const hasSingle = s.indexOf("'") >= 0;
  const hasDouble = s.indexOf('"') >= 0;
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let out = quote;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const c  = ch.charCodeAt(0);
    if (ch === quote) {
      out += "\\" + ch;
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (c === 0x0a) {
      out += "\\n";
    } else if (c === 0x0d) {
      out += "\\r";
    } else if (c === 0x09) {
      out += "\\t";
    } else if (c < 0x20 || c === 0x7f) {
      out += "\\x" + c.toString(16).padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out + quote;
}

/** Python's `str(list[str])` — `['a', 'b']` with each element passed
 *  through `pyStrRepr`. Used wherever the parity surface emits a list
 *  literal in a reason/log string. */
export function pyListRepr(xs: readonly string[]): string {
  return "[" + xs.map(pyStrRepr).join(", ") + "]";
}
