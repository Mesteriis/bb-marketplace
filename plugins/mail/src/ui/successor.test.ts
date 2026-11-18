import { describe, expect, it } from "vitest";
import { extendSelection, successorRow } from "./successor.ts";

const ROWS = ["a", "b", "c", "d", "e"];
const removed = (...ids: string[]) => (id: string) => ids.includes(id);

describe("successorRow", () => {
  it("a row in the middle: the next row", () => {
    expect(successorRow(ROWS, removed("c"), "c")).toBe("d");
  });

  it("the last row: the one above", () => {
    expect(successorRow(ROWS, removed("e"), "e")).toBe("d");
  });

  it("skips a removed run below, else goes above it", () => {
    expect(successorRow(ROWS, removed("b", "c", "d"), "b")).toBe("e");
    expect(successorRow(ROWS, removed("c", "d", "e"), "c")).toBe("b");
    expect(successorRow(ROWS, removed("a", "c", "d", "e"), "d")).toBe("b");
  });

  it("everything removed: null", () => {
    expect(successorRow(ROWS, () => true, "c")).toBeNull();
  });

  it("current not in the list: null", () => {
    expect(successorRow(ROWS, removed("x"), "x")).toBeNull();
    expect(successorRow([], removed("a"), "a")).toBeNull();
  });

  it("search hits are removed by their conversation", () => {
    const hits = [
      { id: "h1", threadId: "t1" },
      { id: "h2", threadId: "t2" },
      { id: "h3", threadId: "t1" },
      { id: "h4", threadId: "t3" },
    ];
    const gone = new Set(["t1"]);
    const isRemoved = (id: string) => gone.has(hits.find((hit) => hit.id === id)?.threadId ?? "");
    expect(successorRow(hits.map((hit) => hit.id), isRemoved, "h1")).toBe("h2");
    expect(successorRow(hits.map((hit) => hit.id), isRemoved, "h3")).toBe("h4");
  });
});

describe("extendSelection", () => {
  it("the first press selects the anchor and the next row", () => {
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "b", to: "c" })].sort()).toEqual(["b", "c"]);
  });

  it("goes up as well as down", () => {
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "d", to: "b" })].sort()).toEqual(["b", "c", "d"]);
  });

  it("turning back over the anchor shrinks the range, then grows it on the other side", () => {
    // Shift+Down twice from b, then Shift+Up three times.
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "b", to: "d" })].sort()).toEqual(["b", "c", "d"]);
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "b", to: "c" })].sort()).toEqual(["b", "c"]);
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "b", to: "b" })].sort()).toEqual(["b"]);
    expect([...extendSelection({ order: ROWS, base: new Set(), anchor: "b", to: "a" })].sort()).toEqual(["a", "b"]);
  });

  it("keeps a selection made with x before the run", () => {
    expect([...extendSelection({ order: ROWS, base: new Set(["e"]), anchor: "a", to: "b" })].sort()).toEqual(["a", "b", "e"]);
    // Shrinking never drops a row the base already had.
    expect([...extendSelection({ order: ROWS, base: new Set(["b"]), anchor: "a", to: "a" })].sort()).toEqual(["a", "b"]);
  });

  it("an anchor or target off the list leaves the base", () => {
    expect([...extendSelection({ order: ROWS, base: new Set(["e"]), anchor: "x", to: "b" })]).toEqual(["e"]);
    expect([...extendSelection({ order: ROWS, base: new Set(["e"]), anchor: "a", to: "x" })]).toEqual(["e"]);
  });
});
