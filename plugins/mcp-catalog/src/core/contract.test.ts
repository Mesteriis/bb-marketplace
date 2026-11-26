import { describe, expect, it } from "vitest";
import { MAX_VALUE_BYTES, MAX_VALUE_KEYS, rpcSchemas } from "./contract";

describe("rpc input caps", () => {
  const install = rpcSchemas.install.input;
  it("accepts 50 keys and 8 KiB per value", () => {
    const values = Object.fromEntries(Array.from({ length: MAX_VALUE_KEYS }, (_, i) => [`K${i}`, "x".repeat(MAX_VALUE_BYTES)]));
    expect(install.safeParse({ name: "a/b", values }).success).toBe(true);
  });

  it("refuses a 51st key and a value over 8 KiB (counted in bytes)", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_VALUE_KEYS + 1 }, (_, i) => [`K${i}`, "x"]));
    expect(install.safeParse({ name: "a/b", values: many }).success).toBe(false);
    expect(install.safeParse({ name: "a/b", values: { K: "x".repeat(MAX_VALUE_BYTES + 1) } }).success).toBe(false);
    expect(install.safeParse({ name: "a/b", values: { K: "я".repeat(MAX_VALUE_BYTES / 2 + 1) } }).success).toBe(false);
  });

  it("applies the same caps to setSecrets and bounds clear", () => {
    const input = rpcSchemas.setSecrets.input;
    expect(input.safeParse({ pluginId: "p", values: { K: "x".repeat(MAX_VALUE_BYTES + 1) }, clear: [] }).success).toBe(false);
    expect(input.safeParse({ pluginId: "p", values: {}, clear: Array.from({ length: 51 }, (_, i) => `K${i}`) }).success).toBe(false);
    expect(input.safeParse({ pluginId: "p", values: { K: "v" }, clear: ["J"] }).success).toBe(true);
  });
});
