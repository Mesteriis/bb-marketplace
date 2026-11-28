import { describe, expect, it } from "vitest";
import { collectDescendants } from "../src/core/tree.ts";

function childrenOf(tree: Record<string, string[]>) {
  return async (id: string) => tree[id] ?? [];
}

describe("collectDescendants", () => {
  it("collects every level without the root", async () => {
    const found = await collectDescendants("a", childrenOf({ a: ["b", "c"], b: ["d"] }));
    expect([...found].sort()).toEqual(["b", "c", "d"]);
  });
  it("stops on a cycle", async () => {
    expect(await collectDescendants("a", childrenOf({ a: ["b"], b: ["a"] }))).toEqual(["b"]);
  });
  it("lists a thread reachable twice once", async () => {
    const found = await collectDescendants("a", childrenOf({ a: ["b", "c"], b: ["c"] }));
    expect([...found].sort()).toEqual(["b", "c"]);
  });
  it("is empty for a leaf", async () => {
    expect(await collectDescendants("a", childrenOf({}))).toEqual([]);
  });
});
