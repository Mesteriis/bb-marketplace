import { describe, expect, it } from "vitest";
import { addBounded, setBounded } from "./bounded.ts";

describe("bounded page-session memory (slice 3i review)", () => {
  it("a set keeps the newest entries only", () => {
    const set = new Set<string>();
    for (let i = 0; i < 10; i++) addBounded(set, `m${i}`, 4);
    expect([...set]).toEqual(["m6", "m7", "m8", "m9"]);
    // Adding one already there refreshes it to the newest.
    addBounded(set, "m6", 4);
    addBounded(set, "m10", 4);
    expect([...set]).toEqual(["m8", "m9", "m6", "m10"]);
  });

  it("a map keeps the newest entries only", () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 30; i++) setBounded(map, `u${i}`, i, 20);
    expect(map.size).toBe(20);
    expect(map.has("u9")).toBe(false);
    expect(map.get("u29")).toBe(29);
  });
});
