// Minimal JSON-Schema-ish validator. Direct port of Python's `_validate`.
//
// Supported keywords (matches what crosscheck-agent's tool schemas use):
//   type, enum, const, properties, required, additionalProperties,
//   items, minimum, maximum, minLength, minItems, anyOf, oneOf.
//
// NOT supported (intentionally): $ref. The Python implementation has
// a best-effort $ref resolver tied to the global schema doc. We omit
// it here — the schemas used inside _request_structured (pick scores,
// confer claims, audit rubric) are inline and self-contained.
//
// Returns a list of human-readable error strings. Empty list = valid.
// Error strings are byte-equal with Python's for the parity surface.
//
// Pure function — no I/O.

/** Validate `value` against the given schema. Returns [] when valid. */
export function validateSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "",
): string[] {
  const errs: string[] = [];

  if ("anyOf" in schema) {
    const subs = (schema["anyOf"] as Record<string, unknown>[]).map(
      (s) => validateSchema(value, s, path),
    );
    if (!subs.some((e) => e.length === 0)) {
      errs.push(`${path || "<root>"}: did not match anyOf`);
    }
    return errs;
  }
  if ("oneOf" in schema) {
    const passed = (schema["oneOf"] as Record<string, unknown>[])
      .filter((s) => validateSchema(value, s, path).length === 0).length;
    if (passed !== 1) {
      errs.push(`${path || "<root>"}: matched ${passed} of oneOf, expected 1`);
    }
    return errs;
  }

  if ("const" in schema && !deepEqual(value, schema["const"])) {
    errs.push(
      `${path || "<root>"}: expected const ${pyRepr(schema["const"])}, got ${pyRepr(value)}`,
    );
    return errs;
  }

  if ("type" in schema) {
    const t = schema["type"];
    const types = Array.isArray(t) ? t : [t];
    const ok = types.some((tt) => matchesType(value, String(tt)));
    if (!ok) {
      errs.push(
        `${path || "<root>"}: expected type ${pyReprType(t)}, got ${pyTypeName(value)}`,
      );
      return errs;
    }
  }

  if (typeof value === "string") {
    if ("enum" in schema) {
      const en = schema["enum"] as unknown[];
      if (!en.some((x) => deepEqual(x, value))) {
        errs.push(`${path || "<root>"}: value ${pyRepr(value)} not in enum`);
      }
    }
    if ("minLength" in schema && value.length < (schema["minLength"] as number)) {
      errs.push(`${path || "<root>"}: shorter than minLength ${schema["minLength"]}`);
    }
  }

  if (typeof value === "number" && !Number.isNaN(value)) {
    if ("minimum" in schema && value < (schema["minimum"] as number)) {
      errs.push(`${path || "<root>"}: ${value} < minimum ${schema["minimum"]}`);
    }
    if ("maximum" in schema && value > (schema["maximum"] as number)) {
      errs.push(`${path || "<root>"}: ${value} > maximum ${schema["maximum"]}`);
    }
  }

  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < (schema["minItems"] as number)) {
      errs.push(`${path || "<root>"}: fewer items than minItems ${schema["minItems"]}`);
    }
    const itemSchema = schema["items"];
    if (isObj(itemSchema)) {
      for (let i = 0; i < value.length; i++) {
        errs.push(...validateSchema(value[i], itemSchema, `${path}[${i}]`));
      }
    }
  }

  if (isObj(value)) {
    const props = (schema["properties"] as Record<string, Record<string, unknown>>) ?? {};
    const required = (schema["required"] as string[]) ?? [];
    for (const r of required) {
      if (!(r in value)) {
        errs.push(`${path || "<root>"}: missing required key ${pyRepr(r)}`);
      }
    }
    if (schema["additionalProperties"] === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) {
          errs.push(`${path || "<root>"}: unknown key ${pyRepr(k)}`);
        }
      }
    }
    for (const [k, v] of Object.entries(value)) {
      const ps = props[k];
      if (ps) errs.push(...validateSchema(v, ps, path ? `${path}.${k}` : k));
    }
  }

  return errs;
}

function matchesType(value: unknown, tt: string): boolean {
  switch (tt) {
    case "string":  return typeof value === "string";
    case "integer": return typeof value === "number"
      && Number.isInteger(value)
      && !Number.isNaN(value);
    case "number":  return typeof value === "number" && !Number.isNaN(value);
    case "boolean": return typeof value === "boolean";
    case "array":   return Array.isArray(value);
    case "object":  return isObj(value);
    case "null":    return value === null;
    default:        return false;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bx = b as unknown[];
    if (a.length !== bx.length) return false;
    return a.every((v, i) => deepEqual(v, bx[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/** Python's repr() for a value embedded in an error string. Mirrors
 *  the f"…{v!r}" interpolations in `_validate`. We don't need the
 *  full pyrepr for non-strings here — only str values are involved in
 *  enum / const / required-key / unknown-key error paths. */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    const hasSingle = v.indexOf("'") >= 0;
    const hasDouble = v.indexOf('"') >= 0;
    const q = hasSingle && !hasDouble ? '"' : "'";
    let out = q;
    for (const ch of v) {
      if (ch === q) out += "\\" + ch;
      else if (ch === "\\") out += "\\\\";
      else out += ch;
    }
    return out + q;
  }
  if (v === null) return "None";
  if (v === true)  return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python `type(value).__name__`. Maps JS runtime types to the names
 *  Python emits in the same code path. */
function pyTypeName(v: unknown): string {
  if (v === null) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return typeof v;
}

/** Python's f"…{t}" where t is the schema's `type` value. For a list
 *  type, Python renders it with the standard list repr (single-quoted
 *  elements). For a string it's bare. */
function pyReprType(t: unknown): string {
  if (Array.isArray(t)) return "[" + t.map((x) => pyRepr(String(x))).join(", ") + "]";
  return String(t);
}
