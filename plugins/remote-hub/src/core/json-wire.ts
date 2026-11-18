// BB's RPC transport carries JSON values only: a property whose value is
// `undefined` is refused before the handler runs ("not a JSON value"), even
// though JSON.stringify would silently drop it. These two helpers are the rule
// in code: `omitUndefined` is what the page applies before a call, and
// `nonJsonPath` is the strict check tests and harnesses apply to every payload.

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The path (`$.a.b[1]`) of the first value JSON cannot carry, or null when the whole value is JSON. */
export function nonJsonPath(value: unknown, path = "$", seen: object[] = []): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : path;
    case "object":
      break;
    default:
      return path; // undefined, function, symbol, bigint
  }
  const object = value as object;
  if (seen.includes(object)) return path;
  const next = [...seen, object];
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      const bad = nonJsonPath(object[i], `${path}[${i}]`, next);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (!isPlainObject(object)) return path;
  for (const [key, child] of Object.entries(object)) {
    const bad = nonJsonPath(child, `${path}.${key}`, next);
    if (bad !== null) return bad;
  }
  return null;
}

/** A copy without undefined-valued keys (objects at any depth; array items are left in place). */
export function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => omitUndefined(item)) as T;
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) out[key] = omitUndefined(child);
    }
    return out as T;
  }
  return value;
}
