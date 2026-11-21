import { describe, expect, it } from "vitest";
import {
  addTab,
  computeLayout,
  createWorkspace,
  focusGroup,
  focusInDirection,
  maximizeGroup,
  moveGroupInDirection,
  moveTabInDirection,
  splitGroup,
} from "../../../src/core/layout/index.ts";
import type { WorkspaceState } from "../../../src/core/layout/index.ts";
import { boxes, OPTIONS, shape } from "./support.ts";

/** a | (b / c): group-1 left, group-2 top right, group-4 bottom right. */
function threeTiles(): WorkspaceState {
  const two = splitGroup(createWorkspace(["a"]), "group-1", "right", "b");
  return splitGroup(two, "group-2", "bottom", "c");
}

/** The same tiles with the top right one a fifth of the height. */
function unevenTiles(): WorkspaceState {
  return {
    root: {
      kind: "split",
      id: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "group", id: "group-1", tabs: ["a"], activeTab: "a" },
        {
          kind: "split",
          id: "split-5",
          direction: "column",
          sizes: [0.2, 0.8],
          children: [
            { kind: "group", id: "group-2", tabs: ["b"], activeTab: "b" },
            { kind: "group", id: "group-4", tabs: ["c"], activeTab: "c" },
          ],
        },
      ],
    },
    focusedGroupId: "group-1",
    maximizedGroupId: null,
    nextNodeId: 6,
  };
}

describe("focusInDirection", () => {
  it("moves the focus to the tile next to the focused one", () => {
    const state = threeTiles();
    expect(focusInDirection(state, "left").focusedGroupId).toBe("group-1");
    expect(focusInDirection(state, "up").focusedGroupId).toBe("group-2");
    expect(focusInDirection(focusGroup(state, "group-2"), "down").focusedGroupId).toBe("group-4");
    expect(focusInDirection(focusGroup(state, "group-2"), "left").focusedGroupId).toBe("group-1");
  });

  it("picks the neighbour sharing the longest edge, the first one on a tie", () => {
    expect(focusInDirection(focusGroup(threeTiles(), "group-1"), "right").focusedGroupId).toBe("group-2");
    expect(focusInDirection(unevenTiles(), "right").focusedGroupId).toBe("group-4");
  });

  it("returns the same state at the edge of the work area and while maximized", () => {
    const state = threeTiles();
    expect(focusInDirection(state, "right")).toBe(state);
    expect(focusInDirection(state, "down")).toBe(state);
    const maximized = maximizeGroup(state, "group-4");
    expect(focusInDirection(maximized, "left")).toBe(maximized);
    const single = createWorkspace(["a"]);
    expect(focusInDirection(single, "left")).toBe(single);
  });
});

describe("moveGroupInDirection", () => {
  it("swaps the group with its neighbour and keeps it focused", () => {
    const state = moveGroupInDirection(threeTiles(), "group-4", "left");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-4", tabs: ["c"], active: "c" },
        {
          split: "split-5",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-1", tabs: ["a"], active: "a" },
          ],
        },
      ],
    });
    expect(state.focusedGroupId).toBe("group-4");
  });

  it("returns the same state without a neighbour or for an unknown group", () => {
    const state = threeTiles();
    expect(moveGroupInDirection(state, "group-4", "down")).toBe(state);
    expect(moveGroupInDirection(state, "group-9", "left")).toBe(state);
  });
});

describe("moveTabInDirection", () => {
  it("moves the tab into the neighbouring group", () => {
    const state = moveTabInDirection(threeTiles(), "c", "up");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        { group: "group-2", tabs: ["b", "c"], active: "c" },
      ],
    });
    expect(state.focusedGroupId).toBe("group-2");
  });

  it("tears the tab out into a new tile when there is no neighbour that way", () => {
    const state = moveTabInDirection(addTab(threeTiles(), "group-4", "d"), "d", "down");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        {
          split: "split-5",
          direction: "column",
          sizes: [0.5, 0.25, 0.25],
          children: [
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-4", tabs: ["c"], active: "c" },
            { group: "group-6", tabs: ["d"], active: "d" },
          ],
        },
      ],
    });
    expect(state.focusedGroupId).toBe("group-6");
  });

  it("returns the same state for the only tab at the edge and for an unknown tab", () => {
    const state = threeTiles();
    expect(moveTabInDirection(state, "c", "down")).toBe(state);
    expect(moveTabInDirection(state, "x", "left")).toBe(state);
  });

  it("leaves maximize when the tab moves from the maximized tile into a hidden one", () => {
    // group-1 holds a and b, group-2 holds c; group-1 is maximized.
    const start = maximizeGroup(addTab(splitGroup(createWorkspace(["a"]), "group-1", "right", "c"), "group-1", "b"), "group-1");
    const state = moveTabInDirection(start, "a", "right");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["b"], active: "b" },
        { group: "group-2", tabs: ["c", "a"], active: "a" },
      ],
    });
    expect(state.focusedGroupId).toBe("group-2");
    expect(state.maximizedGroupId).toBeNull();
    expect(boxes(computeLayout(state, { x: 0, y: 0, width: 1204, height: 800 }, OPTIONS))).toEqual({
      "group-1": [0, 0, 600, 800],
      "split-3#0": [600, 0, 4, 800],
      "group-2": [604, 0, 600, 800],
    });
  });
});
