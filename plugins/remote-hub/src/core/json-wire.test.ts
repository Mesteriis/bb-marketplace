import { describe, expect, it } from "vitest";
import { nonJsonPath, omitUndefined } from "./json-wire.ts";

describe("nonJsonPath: the strict JSON-value check BB's RPC transport applies", () => {
  it("accepts plain JSON, null and nested arrays and objects", () => {
    expect(nonJsonPath({ a: 1, b: "x", c: null, d: [1, { e: true }], f: {} })).toBeNull();
    expect(nonJsonPath(null)).toBeNull();
    expect(nonJsonPath("text")).toBeNull();
  });

  it("names the path of an undefined property, which JSON.stringify would silently drop", () => {
    expect(JSON.stringify({ id: undefined, fields: {} })).toBe('{"fields":{}}'); // the round trip hides it
    expect(nonJsonPath({ id: undefined, fields: {} })).toBe("$.id");
    expect(nonJsonPath({ fields: { port: undefined } })).toBe("$.fields.port");
    expect(nonJsonPath({ list: [1, undefined] })).toBe("$.list[1]");
  });

  it("refuses everything else JSON cannot carry", () => {
    expect(nonJsonPath({ n: Number.NaN })).toBe("$.n");
    expect(nonJsonPath({ n: Number.POSITIVE_INFINITY })).toBe("$.n");
    expect(nonJsonPath({ f: () => 1 })).toBe("$.f");
    expect(nonJsonPath({ b: 1n })).toBe("$.b");
    expect(nonJsonPath({ s: Symbol("x") })).toBe("$.s");
    expect(nonJsonPath({ d: new Date(0) })).toBe("$.d");
    expect(nonJsonPath({ u: new Uint8Array(2) })).toBe("$.u");
    expect(nonJsonPath(undefined)).toBe("$");
  });

  it("does not loop on a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(nonJsonPath(a)).toBe("$.self");
  });
});

describe("omitUndefined", () => {
  it("drops undefined-valued keys at every depth and keeps null, false, 0 and empty strings", () => {
    expect(omitUndefined({ id: undefined, fields: { port: undefined, group: null, favorite: false, n: 0, s: "" }, list: [{ x: undefined, y: 1 }] })).toEqual({
      fields: { group: null, favorite: false, n: 0, s: "" },
      list: [{ y: 1 }],
    });
    expect(nonJsonPath(omitUndefined({ a: { b: undefined } }))).toBeNull();
  });
});
