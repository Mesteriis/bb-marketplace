// The acceptance route of the spec, row "Полное покрытие и реальные жесты
// мышью", driven through the core: one tile on the left, two on the right.
// Every expected tree and pixel below is written out by hand.
import { describe, expect, it } from "vitest";
import {
  applyOperation,
  closeGroup,
  computeLayout,
  createWorkspace,
  maximizeGroup,
  resizeDivider,
  resolveDrop,
  restoreMaximized,
  splitGroup,
} from "../../../src/core/layout/index.ts";
import type { DropResolution, WorkspaceState } from "../../../src/core/layout/index.ts";
import { boxes, coverageProblems, OPTIONS, shape } from "./support.ts";

const BOUNDS = { x: 0, y: 0, width: 1204, height: 800 };

function mustResolve(resolution: DropResolution | null): DropResolution {
  if (resolution === null) throw new Error("expected a drop target");
  return resolution;
}

/** One tile on the left, two on the right: a | (b / c). */
function threeTiles(): WorkspaceState {
  const one = createWorkspace(["a"]);
  const two = splitGroup(one, "group-1", "right", "b");
  return splitGroup(two, "group-2", "bottom", "c");
}

/** Both dividers dragged: the vertical one 100 px right, the nested one 98 px up. */
function resized(): WorkspaceState {
  const wide = resizeDivider(threeTiles(), "split-3", 0, 100, BOUNDS, OPTIONS);
  return resizeDivider(wide, "split-5", 0, -98, BOUNDS, OPTIONS);
}

describe("one tile on the left, two on the right", () => {
  it("builds the three tiles and covers the work area exactly", () => {
    const state = threeTiles();
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
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-4", tabs: ["c"], active: "c" },
          ],
        },
      ],
    });
    expect(state.focusedGroupId).toBe("group-4");
    const geometry = computeLayout(state, BOUNDS, OPTIONS);
    expect(geometry.mode).toBe("tiled");
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 600, 800],
      "split-3#0": [600, 0, 4, 800],
      "group-2": [604, 0, 600, 398],
      "split-5#0": [604, 398, 600, 4],
      "group-4": [604, 402, 600, 398],
    });
    expect(coverageProblems(geometry, BOUNDS)).toEqual([]);
  });

  it("drags the vertical divider: the left tile gains what the right column loses", () => {
    const state = resizeDivider(threeTiles(), "split-3", 0, 100, BOUNDS, OPTIONS);
    expect(boxes(computeLayout(state, BOUNDS, OPTIONS))).toEqual({
      "group-1": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-2": [704, 0, 500, 398],
      "split-5#0": [704, 398, 500, 4],
      "group-4": [704, 402, 500, 398],
    });
  });

  it("drags the nested divider: only the two right tiles change", () => {
    const state = resized();
    expect(shape(state.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5833, 0.4167],
      children: [
        { group: "group-1", tabs: ["a"], active: "a" },
        {
          split: "split-5",
          direction: "column",
          sizes: [0.3769, 0.6231],
          children: [
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-4", tabs: ["c"], active: "c" },
          ],
        },
      ],
    });
    const geometry = computeLayout(state, BOUNDS, OPTIONS);
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-2": [704, 0, 500, 300],
      "split-5#0": [704, 300, 500, 4],
      "group-4": [704, 304, 500, 496],
    });
    expect(coverageProblems(geometry, BOUNDS)).toEqual([]);
  });

  it("stops both dividers at the minimum tile size and leaves no hole", () => {
    const state = resized();
    const squeezed = resizeDivider(state, "split-5", 0, -1000, BOUNDS, OPTIONS);
    expect(boxes(computeLayout(squeezed, BOUNDS, OPTIONS))).toEqual({
      "group-1": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-2": [704, 0, 500, 120],
      "split-5#0": [704, 120, 500, 4],
      "group-4": [704, 124, 500, 676],
    });
    expect(resizeDivider(squeezed, "split-5", 0, -1, BOUNDS, OPTIONS)).toBe(squeezed);

    const narrowed = resizeDivider(state, "split-3", 0, 1000, BOUNDS, OPTIONS);
    const geometry = computeLayout(narrowed, BOUNDS, OPTIONS);
    expect(boxes(geometry)).toEqual({
      "group-1": [0, 0, 960, 800],
      "split-3#0": [960, 0, 4, 800],
      "group-2": [964, 0, 240, 300],
      "split-5#0": [964, 300, 240, 4],
      "group-4": [964, 304, 240, 496],
    });
    expect(coverageProblems(geometry, BOUNDS)).toEqual([]);
    expect(resizeDivider(narrowed, "split-3", 0, 5, BOUNDS, OPTIONS)).toBe(narrowed);
  });

  it("runs the whole route: swap, last tab, cancel, close, width, maximize, last tile", () => {
    // Swap: the header of the left tile is dropped on the centre of the top right one.
    const beforeSwap = resized();
    const swap = mustResolve(resolveDrop(beforeSwap, { kind: "group", groupId: "group-1" }, { x: 954, y: 150 }, BOUNDS, OPTIONS));
    expect(swap).toEqual({
      targetGroupId: "group-2",
      zone: "center",
      preview: { x: 704, y: 0, width: 500, height: 300 },
      operation: { type: "swapGroups", groupId: "group-1", targetGroupId: "group-2" },
    });
    const swapped = applyOperation(beforeSwap, swap.operation);
    expect(boxes(computeLayout(swapped, BOUNDS, OPTIONS))).toEqual({
      "group-2": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 300],
      "split-5#0": [704, 300, 500, 4],
      "group-4": [704, 304, 500, 496],
    });

    // Last tab: tab "c" is the only tab of the bottom right tile and joins the top right one.
    const join = mustResolve(resolveDrop(swapped, { kind: "tab", panelId: "c" }, { x: 954, y: 150 }, BOUNDS, OPTIONS));
    expect(join).toEqual({
      targetGroupId: "group-1",
      zone: "center",
      preview: { x: 704, y: 0, width: 500, height: 800 },
      operation: { type: "moveTab", panelId: "c", targetGroupId: "group-1" },
    });
    const joined = applyOperation(swapped, join.operation);
    expect(shape(joined.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5833, 0.4167],
      children: [
        { group: "group-2", tabs: ["b"], active: "b" },
        { group: "group-1", tabs: ["a", "c"], active: "c" },
      ],
    });
    expect(joined.focusedGroupId).toBe("group-1");
    const joinedGeometry = computeLayout(joined, BOUNDS, OPTIONS);
    expect(boxes(joinedGeometry)).toEqual({
      "group-2": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 800],
    });
    expect(coverageProblems(joinedGeometry, BOUNDS)).toEqual([]);

    // Cancel: a drag that is held and then released with Escape, outside the
    // work area or on its own tile applies nothing.
    const held = mustResolve(resolveDrop(joined, { kind: "tab", panelId: "c" }, { x: 350, y: 790 }, BOUNDS, OPTIONS));
    expect(held).toEqual({
      targetGroupId: "group-2",
      zone: "bottom",
      preview: { x: 0, y: 402, width: 700, height: 398 },
      operation: { type: "moveTabToEdge", panelId: "c", targetGroupId: "group-2", edge: "bottom" },
    });
    expect(boxes(computeLayout(joined, BOUNDS, OPTIONS))).toEqual(boxes(joinedGeometry));
    expect(resolveDrop(joined, { kind: "tab", panelId: "c" }, { x: 1300, y: 400 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(joined, { kind: "group", groupId: "group-1" }, { x: 954, y: 400 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(joined, { kind: "tab", panelId: "c" }, { x: 954, y: 400 }, BOUNDS, OPTIONS)).toBeNull();

    // The same drag again, now confirmed: three tiles, two on the left.
    const torn = applyOperation(joined, held.operation);
    expect(shape(torn.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5833, 0.4167],
      children: [
        {
          split: "split-7",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { group: "group-2", tabs: ["b"], active: "b" },
            { group: "group-6", tabs: ["c"], active: "c" },
          ],
        },
        { group: "group-1", tabs: ["a"], active: "a" },
      ],
    });
    expect(boxes(computeLayout(torn, BOUNDS, OPTIONS))).toEqual({
      "group-2": [0, 0, 700, 398],
      "split-7#0": [0, 398, 700, 4],
      "group-6": [0, 402, 700, 398],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 800],
    });

    // Close a tile: its neighbour takes the place and the divider is gone.
    const closed = closeGroup(torn, "group-2");
    expect(shape(closed.root)).toEqual({
      split: "split-3",
      direction: "row",
      sizes: [0.5833, 0.4167],
      children: [
        { group: "group-6", tabs: ["c"], active: "c" },
        { group: "group-1", tabs: ["a"], active: "a" },
      ],
    });
    expect(closed.focusedGroupId).toBe("group-6");
    expect(boxes(computeLayout(closed, BOUNDS, OPTIONS))).toEqual({
      "group-6": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 800],
    });

    // The window gets narrower, then the BB sidebar gets wider.
    const narrowWindow = { x: 0, y: 0, width: 1004, height: 800 };
    const narrowGeometry = computeLayout(closed, narrowWindow, OPTIONS);
    expect(boxes(narrowGeometry)).toEqual({
      "group-6": [0, 0, 583, 800],
      "split-3#0": [583, 0, 4, 800],
      "group-1": [587, 0, 417, 800],
    });
    expect(coverageProblems(narrowGeometry, narrowWindow)).toEqual([]);
    const besideSidebar = { x: 200, y: 0, width: 804, height: 800 };
    const sidebarGeometry = computeLayout(closed, besideSidebar, OPTIONS);
    expect(boxes(sidebarGeometry)).toEqual({
      "group-6": [200, 0, 467, 800],
      "split-3#0": [667, 0, 4, 800],
      "group-1": [671, 0, 333, 800],
    });
    expect(coverageProblems(sidebarGeometry, besideSidebar)).toEqual([]);

    // Too narrow: one tile on the whole surface, the saved tree untouched.
    const compact = computeLayout(closed, { x: 0, y: 0, width: 500, height: 800 }, OPTIONS);
    expect(compact.mode).toBe("compact");
    expect(boxes(compact)).toEqual({ "group-6": [0, 0, 500, 800] });
    expect(boxes(computeLayout(closed, BOUNDS, OPTIONS))).toEqual({
      "group-6": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 800],
    });

    // Maximize and restore.
    const maximized = maximizeGroup(closed, "group-1");
    const maximizedGeometry = computeLayout(maximized, BOUNDS, OPTIONS);
    expect(maximizedGeometry.mode).toBe("maximized");
    expect(boxes(maximizedGeometry)).toEqual({ "group-1": [0, 0, 1204, 800] });
    const restored = restoreMaximized(maximized);
    expect(restored.root).toBe(closed.root);
    expect(boxes(computeLayout(restored, BOUNDS, OPTIONS))).toEqual({
      "group-6": [0, 0, 700, 800],
      "split-3#0": [700, 0, 4, 800],
      "group-1": [704, 0, 500, 800],
    });

    // Close down to the last tile, then close it too.
    const single = closeGroup(restored, "group-6");
    expect(shape(single.root)).toEqual({ group: "group-1", tabs: ["a"], active: "a" });
    expect(boxes(computeLayout(single, BOUNDS, OPTIONS))).toEqual({ "group-1": [0, 0, 1204, 800] });
    const empty = closeGroup(single, "group-1");
    expect(shape(empty.root)).toEqual({ group: "group-8", tabs: [], active: null });
    expect(empty.focusedGroupId).toBe("group-8");
    expect(empty.maximizedGroupId).toBeNull();
    const emptyGeometry = computeLayout(empty, BOUNDS, OPTIONS);
    expect(boxes(emptyGeometry)).toEqual({ "group-8": [0, 0, 1204, 800] });
    expect(coverageProblems(emptyGeometry, BOUNDS)).toEqual([]);
    expect(closeGroup(empty, "group-8")).toBe(empty);
  });
});
