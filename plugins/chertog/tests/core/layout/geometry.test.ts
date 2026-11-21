import { describe, expect, it } from "vitest";
import {
  computeLayout,
  createWorkspace,
  DEFAULT_LAYOUT_OPTIONS,
  maximizeGroup,
  resizeDivider,
  splitGroup,
} from "../../../src/core/layout/index.ts";
import type { WorkspaceState } from "../../../src/core/layout/index.ts";
import { boxes, coverageProblems, OPTIONS } from "./support.ts";

function twoColumns(): WorkspaceState {
  return splitGroup(createWorkspace(["a"]), "group-1", "right", "b");
}

/** Three columns with shares 0.5, 0.25, 0.25. */
function threeColumns(): WorkspaceState {
  return splitGroup(twoColumns(), "group-2", "right", "c");
}

describe("computeLayout", () => {
  it("gives a single group the whole work area", () => {
    const bounds = { x: 280, y: 48, width: 1000, height: 700 };
    const geometry = computeLayout(createWorkspace(), bounds, OPTIONS);
    expect(geometry.mode).toBe("tiled");
    expect(boxes(geometry)).toEqual({ "group-1": [280, 48, 1000, 700] });
  });

  it("lays out from the origin of the work area, not from zero", () => {
    const bounds = { x: 280, y: 48, width: 1004, height: 700 };
    const geometry = computeLayout(twoColumns(), bounds, OPTIONS);
    expect(boxes(geometry)).toEqual({
      "group-1": [280, 48, 500, 700],
      "split-3#0": [780, 48, 4, 700],
      "group-2": [784, 48, 500, 700],
    });
    expect(geometry.dividers).toEqual([
      { splitId: "split-3", index: 0, direction: "row", rect: { x: 780, y: 48, width: 4, height: 700 } },
    ]);
    expect(coverageProblems(geometry, bounds)).toEqual([]);
  });

  it("rounds a shared boundary once: a half pixel goes to the first tile", () => {
    const bounds = { x: 0, y: 0, width: 705, height: 301 };
    const geometry = computeLayout(twoColumns(), bounds, OPTIONS);
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 351, 301],
      "split-3#0": [351, 0, 4, 301],
      "group-2": [355, 0, 350, 301],
    });
    expect(coverageProblems(geometry, bounds)).toEqual([]);
  });

  it("spreads rounding over three columns without a gap at the far edge", () => {
    const bounds = { x: 0, y: 0, width: 1009, height: 100 };
    const geometry = computeLayout(threeColumns(), bounds, OPTIONS);
    // 1001 px for tiles: boundaries at 500.5 -> 501 and 750.75 -> 751.
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 501, 100],
      "split-3#0": [501, 0, 4, 100],
      "group-2": [505, 0, 250, 100],
      "split-3#1": [755, 0, 4, 100],
      "group-4": [759, 0, 250, 100],
    });
    expect(coverageProblems(geometry, bounds)).toEqual([]);
  });

  it("shows only the maximized group", () => {
    const bounds = { x: 10, y: 20, width: 1004, height: 700 };
    const geometry = computeLayout(maximizeGroup(twoColumns(), "group-1"), bounds, OPTIONS);
    expect(geometry.mode).toBe("maximized");
    expect(boxes(geometry)).toEqual({ "group-1": [10, 20, 1004, 700] });
    expect(geometry.dividers).toEqual([]);
  });

  it("below the compact width shows the focused group alone and keeps the tree", () => {
    const state = twoColumns();
    const before = JSON.stringify(state);
    const geometry = computeLayout(state, { x: 0, y: 0, width: 639, height: 700 }, OPTIONS);
    expect(geometry.mode).toBe("compact");
    expect(boxes(geometry)).toEqual({ "group-2": [0, 0, 639, 700] });
    expect(JSON.stringify(state)).toBe(before);
    expect(computeLayout(state, { x: 0, y: 0, width: 640, height: 700 }, OPTIONS).mode).toBe("tiled");
  });

  it("in compact mode shows the maximized group", () => {
    const state = maximizeGroup(twoColumns(), "group-1");
    const geometry = computeLayout(state, { x: 0, y: 0, width: 300, height: 700 }, OPTIONS);
    expect(geometry.mode).toBe("compact");
    expect(boxes(geometry)).toEqual({ "group-1": [0, 0, 300, 700] });
  });

  it("still covers an area narrower than its dividers", () => {
    const bounds = { x: 0, y: 0, width: 3, height: 10 };
    const geometry = computeLayout(twoColumns(), bounds, { ...OPTIONS, compactWidth: 0 });
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 0, 10],
      "split-3#0": [0, 0, 3, 10],
      "group-2": [3, 0, 0, 10],
    });
    expect(coverageProblems(geometry, bounds)).toEqual([]);
    expect(boxes(computeLayout(twoColumns(), { x: 5, y: 5, width: 0, height: 0 }, { ...OPTIONS, compactWidth: 0 }))).toEqual({
      "group-1": [5, 5, 0, 0],
      "split-3#0": [5, 5, 0, 0],
      "group-2": [5, 5, 0, 0],
    });
  });

  it("has usable defaults", () => {
    expect(DEFAULT_LAYOUT_OPTIONS).toEqual({
      dividerSize: 4,
      minTileWidth: 240,
      minTileHeight: 160,
      compactWidth: 640,
      dropEdgeFraction: 0.25,
    });
    expect(boxes(computeLayout(twoColumns(), { x: 0, y: 0, width: 1004, height: 600 }))).toEqual({
      "group-1": [0, 0, 500, 600],
      "split-3#0": [500, 0, 4, 600],
      "group-2": [504, 0, 500, 600],
    });
  });
});

describe("resizeDivider", () => {
  const bounds = { x: 0, y: 0, width: 1208, height: 600 };

  it("changes only the two tiles beside the divider and keeps the sum", () => {
    const start = threeColumns();
    expect(boxes(computeLayout(start, bounds, OPTIONS))).toEqual({
      "group-1": [0, 0, 600, 600],
      "split-3#0": [600, 0, 4, 600],
      "group-2": [604, 0, 300, 600],
      "split-3#1": [904, 0, 4, 600],
      "group-4": [908, 0, 300, 600],
    });
    const state = resizeDivider(start, "split-3", 1, 50, bounds, OPTIONS);
    expect(boxes(computeLayout(state, bounds, OPTIONS))).toEqual({
      "group-1": [0, 0, 600, 600],
      "split-3#0": [600, 0, 4, 600],
      "group-2": [604, 0, 350, 600],
      "split-3#1": [954, 0, 4, 600],
      "group-4": [958, 0, 250, 600],
    });
    const sizes = state.root.kind === "split" ? state.root.sizes : [];
    expect(sizes[0]).toBe(0.5);
    expect(sizes[1]).toBeCloseTo(350 / 1200, 12);
    expect(sizes[2]).toBeCloseTo(250 / 1200, 12);
    expect(sizes[0] + sizes[1] + sizes[2]).toBeCloseTo(1, 12);
  });

  it("moves a boundary that sat on a half pixel by exactly the dragged distance", () => {
    const odd = { x: 0, y: 0, width: 705, height: 301 };
    const state = resizeDivider(twoColumns(), "split-3", 0, 10, odd, OPTIONS);
    expect(boxes(computeLayout(state, odd, OPTIONS))).toEqual({
      "group-1": [0, 0, 361, 301],
      "split-3#0": [361, 0, 4, 301],
      "group-2": [365, 0, 340, 301],
    });
    const back = resizeDivider(state, "split-3", 0, -10, odd, OPTIONS);
    expect(boxes(computeLayout(back, odd, OPTIONS))).toEqual({
      "group-1": [0, 0, 351, 301],
      "split-3#0": [351, 0, 4, 301],
      "group-2": [355, 0, 350, 301],
    });
  });

  it("stops at the minimum width in both directions", () => {
    const left = resizeDivider(threeColumns(), "split-3", 0, -5000, bounds, OPTIONS);
    expect(boxes(computeLayout(left, bounds, OPTIONS))).toMatchObject({
      "group-1": [0, 0, 240, 600],
      "group-2": [244, 0, 660, 600],
      "group-4": [908, 0, 300, 600],
    });
    const right = resizeDivider(threeColumns(), "split-3", 0, 5000, bounds, OPTIONS);
    expect(boxes(computeLayout(right, bounds, OPTIONS))).toMatchObject({
      "group-1": [0, 0, 660, 600],
      "group-2": [664, 0, 240, 600],
      "group-4": [908, 0, 300, 600],
    });
  });

  it("counts the tiles inside a nested split of the same axis towards the minimum", () => {
    // a | (b / (c | d)): the right column holds two tiles side by side in its
    // lower half, so it cannot get narrower than 240 + 4 + 240.
    const nested = splitGroup(splitGroup(twoColumns(), "group-2", "bottom", "c"), "group-4", "right", "d");
    const state = resizeDivider(nested, "split-3", 0, 5000, bounds, OPTIONS);
    expect(boxes(computeLayout(state, bounds, OPTIONS))).toEqual({
      "group-1": [0, 0, 720, 600],
      "split-3#0": [720, 0, 4, 600],
      "group-2": [724, 0, 484, 298],
      "split-5#0": [724, 298, 484, 4],
      "group-4": [724, 302, 240, 298],
      "split-7#0": [964, 302, 4, 298],
      "group-6": [968, 302, 240, 298],
    });
  });

  it("returns the same state when nothing can move", () => {
    const state = threeColumns();
    expect(resizeDivider(state, "split-3", 0, 0, bounds, OPTIONS)).toBe(state);
    expect(resizeDivider(state, "split-3", 0, 0.4, bounds, OPTIONS)).toBe(state);
    expect(resizeDivider(state, "split-3", 0, Number.NaN, bounds, OPTIONS)).toBe(state);
    expect(resizeDivider(state, "split-3", 2, 10, bounds, OPTIONS)).toBe(state);
    expect(resizeDivider(state, "split-3", -1, 10, bounds, OPTIONS)).toBe(state);
    expect(resizeDivider(state, "split-9", 0, 10, bounds, OPTIONS)).toBe(state);
    const maximized = maximizeGroup(state, "group-1");
    expect(resizeDivider(maximized, "split-3", 0, 10, bounds, OPTIONS)).toBe(maximized);
    expect(resizeDivider(state, "split-3", 0, 10, { x: 0, y: 0, width: 500, height: 600 }, OPTIONS)).toBe(state);
  });
});
