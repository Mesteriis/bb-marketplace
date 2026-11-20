// Optional object fields are omitted on the wire while BB validates the remaining values.
export function omitUndefinedRpcFields(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = new Array<unknown>(value.length);
    seen.set(value, result);
    value.forEach((entry, index) => { result[index] = omitUndefinedRpcFields(entry, seen); });
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) return value;
  const result: Record<string, unknown> = Object.create(null);
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = omitUndefinedRpcFields(entry, seen);
  }
  return result;
}
