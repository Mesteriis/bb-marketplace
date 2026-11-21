import { describe, expect, it } from "vitest";
import {
  activateTab,
  addTab,
  closeGroup,
  closeTab,
  createWorkspace,
  focusGroup,
  maximizeGroup,
  moveGroup,
  moveTab,
  moveTabToEdge,
  restoreMaximized,
  splitGroup,
  swapGroups,
  toggleMaximize,
} from "../../../src/core/layout/index.ts";
import type { WorkspaceState } from "../../../src/core/layout/index.ts";
import { shape } from "./support.ts";

/** a | (b / c): group-1 left, group-2 top right, group-4 bottom right. */
function threeTiles(): WorkspaceState {
  const two = splitGroup(createWorkspace(["a"]), "group-1", "right", "b");
  return splitGroup(two, "group-2", "bottom", "c");
}

describe("createWorkspace and addTab", () => {
  it("starts with one empty content-picker group", () => {
    expect(createWorkspace()).toEqual({
      root: { kind: "group", id: "group-1", tabs: [], activeTab: null },
      focusedGroupId: "group-1",
      maximizedGroupId: null,
      nextNodeId: 2,
    });
  });

  it("opens the given panels as tabs of one group, first one active", () => {
    expect(shape(createWorkspace(["a", "b", "a"]).root)).toEqual({ group: "group-1", tabs: ["a", "b"], active: "a" });
  });

  it("adds a tab to a group, activates it and focuses the group", () => {
    const state = addTab(threeTiles(), "group-1", "d");
    expect(shape(state.root)).toMatchObject({ children: [{ group: "group-1", tabs: ["a", "d"], active: "d" }, {}] });
    expect(state.focusedGroupId).toBe("group-1");
  });

  it("fills the empty picker group in place", () => {
    expect(shape(addTab(createWorkspace(), "group-1", "a").root)).toEqual({ group: "group-1", tabs: ["a"], active: "a" });
  });

  it("refuses a panel that is already placed and an unknown group", () => {
    const state = threeTiles();
    expect(addTab(state, "group-1", "c")).toBe(state);
    expect(addTab(state, "group-9", "d")).toBe(state);
  });
});

describe("splitGroup", () => {
  it.each([
    ["left", "row", ["group-2", "group-1"]],
    ["right", "row", ["group-1", "group-2"]],
    ["top", "column", ["group-2", "group-1"]],
    ["bottom", "column", ["group-1", "group-2"]],
  ] as const)("puts the new tile on the %s", (edge, direction, order) => {
    const state = splitGroup(createWorkspace(["a"]), "group-1", edge, "b");
    expect(shape(state.root)).toMatchObject({ split: "split-3", direction, sizes: [0.5, 0.5] });
    expect(state.root.kind === "split" ? state.root.children.map((child) => child.id) : []).toEqual(order);
    expect(state.focusedGroupId).toBe("group-2");
  });

  it("adds a sibling instead of nesting a split of the same direction", () => {
    const two = splitGroup(createWorkspace(["a"]), "group-1", "right", "b");
    const three = splitGroup(two, "group-2", "right", "c");
    expect(shape(three.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        { group: "group-2", tabs: ["b"], active: "b" },
        { group: "group-4", tabs: ["c"], active: "c" },
      ],
    });
  });

  it("replaces the empty picker instead of leaving an empty tile beside the new one", () => {
    const state = splitGroup(createWorkspace(), "group-1", "right", "a");
    expect(shape(state.root)).toEqual({ group: "group-2", tabs: ["a"], active: "a" });
    expect(state.focusedGroupId).toBe("group-2");
  });

  it("refuses a placed panel and an unknown target", () => {
    const state = threeTiles();
    expect(splitGroup(state, "group-1", "left", "b")).toBe(state);
    expect(splitGroup(state, "group-9", "left", "d")).toBe(state);
  });

  it("leaves maximize so the new tile is visible", () => {
    const state = splitGroup(maximizeGroup(threeTiles(), "group-1"), "group-1", "top", "d");
    expect(state.maximizedGroupId).toBeNull();
  });
});

describe("moveTab", () => {
  it("moves a tab to another group and keeps the source active tab valid", () => {
    const start = addTab(threeTiles(), "group-1", "d");
    const state = moveTab(start, "d", "group-2");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        {
          split: "split-5",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { group: "group-2", tabs: ["b", "d"], active: "d" },
            { group: "group-4", tabs: ["c"], active: "c" },
          ],
        },
      ],
    });
    expect(state.focusedGroupId).toBe("group-2");
  });

  it("inserts at an index and reorders inside one group", () => {
    const start = createWorkspace(["a", "b", "c"]);
    expect(shape(moveTab(start, "c", "group-1", 0).root)).toEqual({ group: "group-1", tabs: ["c", "a", "b"], active: "c" });
    expect(shape(moveTab(start, "a", "group-1", 99).root)).toEqual({ group: "group-1", tabs: ["b", "c", "a"], active: "a" });
    const other = splitGroup(start, "group-1", "right", "d");
    expect(shape(moveTab(other, "d", "group-1", 1).root)).toEqual({ group: "group-1", tabs: ["a", "d", "b", "c"], active: "d" });
  });

  it("removes the source group with its last tab; the sibling takes the whole column", () => {
    const state = moveTab(threeTiles(), "c", "group-1");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["a", "c"], active: "c" },
        { group: "group-2", tabs: ["b"], active: "b" },
      ],
    });
  });

  it("returns the same state for a drop on its own group, an unchanged order and unknown ids", () => {
    const state = createWorkspace(["a", "b"]);
    expect(moveTab(state, "a", "group-1")).toBe(state);
    expect(moveTab(state, "a", "group-1", 0)).toBe(state);
    expect(moveTab(state, "x", "group-1")).toBe(state);
    expect(moveTab(state, "a", "group-9")).toBe(state);
  });
});

describe("moveTabToEdge", () => {
  it("tears a tab out into a new tile beside the target", () => {
    const start = addTab(threeTiles(), "group-1", "d");
    const state = moveTabToEdge(start, "d", "group-1", "left");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.25, 0.25, 0.5],
      children: [
        { group: "group-6", tabs: ["d"], active: "d" },
        { group: "group-1", tabs: ["a"], active: "a" },
        {
          split: "split-5",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-4", tabs: ["c"], active: "c" },
          ],
        },
      ],
    });
    expect(state.focusedGroupId).toBe("group-6");
  });

  it("returns the same state when the only tab is dropped on its own tile", () => {
    const state = threeTiles();
    expect(moveTabToEdge(state, "a", "group-1", "bottom")).toBe(state);
    expect(moveTabToEdge(state, "x", "group-1", "bottom")).toBe(state);
    expect(moveTabToEdge(state, "a", "group-9", "bottom")).toBe(state);
  });
});

describe("moveGroup and swapGroups", () => {
  it("moves a whole group to an edge of another; the freed place closes up", () => {
    const state = moveGroup(threeTiles(), "group-4", "group-1", "left");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.25, 0.25, 0.5],
      children: [
        { group: "group-4", tabs: ["c"], active: "c" },
        { group: "group-1", tabs: ["a"], active: "a" },
        { group: "group-2", tabs: ["b"], active: "b" },
      ],
    });
    expect(state.focusedGroupId).toBe("group-4");
  });

  it("keeps all tabs and the active tab of the moved group", () => {
    const start = addTab(addTab(threeTiles(), "group-4", "d"), "group-4", "e");
    const state = moveGroup(activateTab(start, "d"), "group-4", "group-2", "top");
    expect(shape(state.root)).toMatchObject({
      children: [
        {},
        {
          split: "split-6",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { group: "group-4", tabs: ["c", "d", "e"], active: "d" },
            { group: "group-2", tabs: ["b"], active: "b" },
          ],
        },
      ],
    });
  });

  it("swaps two groups; places and shares stay where they were", () => {
    const state = swapGroups(threeTiles(), "group-1", "group-4");
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

  it("returns the same state for a drop on itself and for unknown groups", () => {
    const state = threeTiles();
    expect(moveGroup(state, "group-1", "group-1", "left")).toBe(state);
    expect(moveGroup(state, "group-1", "group-9", "left")).toBe(state);
    expect(moveGroup(state, "group-9", "group-1", "left")).toBe(state);
    expect(swapGroups(state, "group-2", "group-2")).toBe(state);
    expect(swapGroups(state, "group-2", "group-9")).toBe(state);
  });
});

describe("closeTab and closeGroup", () => {
  it("activates the neighbouring tab when the active one closes", () => {
    const start = activateTab(createWorkspace(["a", "b", "c"]), "b");
    expect(shape(closeTab(start, "b").root)).toEqual({ group: "group-1", tabs: ["a", "c"], active: "c" });
    expect(shape(closeTab(activateTab(start, "c"), "c").root)).toEqual({ group: "group-1", tabs: ["a", "b"], active: "b" });
    expect(shape(closeTab(start, "a").root)).toEqual({ group: "group-1", tabs: ["b", "c"], active: "b" });
  });

  it("closes the group with its last tab and focuses the tile that took the place", () => {
    const state = closeTab(threeTiles(), "c");
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        { group: "group-2", tabs: ["b"], active: "b" },
      ],
    });
    expect(state.focusedGroupId).toBe("group-2");
  });

  it("shares the freed place between the remaining siblings in proportion", () => {
    const row = splitGroup(splitGroup(createWorkspace(["a"]), "group-1", "right", "b"), "group-2", "right", "c");
    expect(shape(closeGroup(row, "group-1").root)).toMatchObject({ split: "split-3", sizes: [0.5, 0.5] });
    expect(shape(closeGroup(row, "group-4").root)).toMatchObject({ split: "split-3", sizes: [0.6667, 0.3333] });
  });

  it("merges a split left with one child into a parent of the same direction", () => {
    // a | (b / (c | d)); closing b leaves a | c | d in one row.
    const start = splitGroup(threeTiles(), "group-4", "right", "d");
    expect(shape(start.root)).toMatchObject({
      children: [{}, { split: "split-5", children: [{}, { split: "split-7", direction: "row" }] }],
    });
    expect(shape(closeGroup(start, "group-2").root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5, 0.25, 0.25],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        { group: "group-4", tabs: ["c"], active: "c" },
        { group: "group-6", tabs: ["d"], active: "d" },
      ],
    });
  });

  it("leaves exactly one empty picker group after the last tab or group closes", () => {
    const byTab = closeTab(createWorkspace(["a"]), "a");
    expect(byTab).toEqual({
      root: { kind: "group", id: "group-2", tabs: [], activeTab: null },
      focusedGroupId: "group-2",
      maximizedGroupId: null,
      nextNodeId: 3,
    });
    const byGroup = closeGroup(maximizeGroup(createWorkspace(["a", "b"]), "group-1"), "group-1");
    expect(byGroup).toEqual({
      root: { kind: "group", id: "group-2", tabs: [], activeTab: null },
      focusedGroupId: "group-2",
      maximizedGroupId: null,
      nextNodeId: 3,
    });
    expect(closeGroup(byGroup, "group-2")).toBe(byGroup);
  });

  it("returns the same state for unknown ids", () => {
    const state = threeTiles();
    expect(closeTab(state, "x")).toBe(state);
    expect(closeGroup(state, "group-9")).toBe(state);
  });
});

describe("focus and maximize", () => {
  it("focuses a group and activates a tab", () => {
    const state = threeTiles();
    expect(focusGroup(state, "group-1").focusedGroupId).toBe("group-1");
    expect(focusGroup(state, "group-4")).toBe(state);
    expect(focusGroup(state, "group-9")).toBe(state);
    const tabs = addTab(state, "group-1", "d");
    const activated = activateTab(focusGroup(tabs, "group-4"), "a");
    expect(shape(activated.root)).toMatchObject({ children: [{ group: "group-1", active: "a" }, {}] });
    expect(activated.focusedGroupId).toBe("group-1");
    expect(activateTab(activated, "a")).toBe(activated);
    expect(activateTab(activated, "x")).toBe(activated);
  });

  it("maximizes without touching the tree and restores the same shares", () => {
    const state = threeTiles();
    const maximized = maximizeGroup(state, "group-2");
    expect(maximized.maximizedGroupId).toBe("group-2");
    expect(maximized.focusedGroupId).toBe("group-2");
    expect(maximized.root).toBe(state.root);
    expect(maximizeGroup(maximized, "group-2")).toBe(maximized);
    expect(maximizeGroup(state, "group-9")).toBe(state);
    const restored = restoreMaximized(maximized);
    expect(restored.maximizedGroupId).toBeNull();
    expect(restored.root).toBe(state.root);
    expect(restoreMaximized(restored)).toBe(restored);
    expect(toggleMaximize(state, "group-2").maximizedGroupId).toBe("group-2");
    expect(toggleMaximize(maximized, "group-2").maximizedGroupId).toBeNull();
    expect(toggleMaximize(maximized, "group-1").maximizedGroupId).toBe("group-1");
  });

  it("never keeps the focus on a tile hidden behind a maximized one", () => {
    const maximized = maximizeGroup(addTab(threeTiles(), "group-1", "d"), "group-1");
    for (const state of [
      focusGroup(maximized, "group-2"),
      activateTab(maximized, "b"),
      addTab(maximized, "group-2", "e"),
      moveTab(maximized, "d", "group-2"),
    ]) {
      expect(state.focusedGroupId).toBe("group-2");
      expect(state.maximizedGroupId).toBeNull();
    }
    // Work inside the maximized tile keeps it maximized.
    for (const state of [addTab(maximized, "group-1", "e"), closeTab(maximized, "d"), activateTab(maximized, "a"), closeTab(maximized, "c")]) {
      expect(state.focusedGroupId).toBe("group-1");
      expect(state.maximizedGroupId).toBe("group-1");
    }
  });

  it("drops maximize when the maximized group closes", () => {
    const state = closeGroup(maximizeGroup(threeTiles(), "group-2"), "group-2");
    expect(state.maximizedGroupId).toBeNull();
    expect(state.focusedGroupId).toBe("group-4");
  });
});
