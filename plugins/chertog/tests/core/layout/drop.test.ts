import { describe, expect, it } from "vitest";
import {
  addTab,
  applyOperation,
  computeLayout,
  createWorkspace,
  maximizeGroup,
  resolveDrop,
  splitGroup,
} from "../../../src/core/layout/index.ts";
import type { DragSource, WorkspaceState } from "../../../src/core/layout/index.ts";
import { boxes, OPTIONS, shape } from "./support.ts";

// group-1 "a" occupies 0..400, the divider 400..404, group-2 "b" 404..804.
const BOUNDS = { x: 0, y: 0, width: 804, height: 400 };
const TAB_B: DragSource = { kind: "tab", panelId: "b" };
const HEADER_2: DragSource = { kind: "group", groupId: "group-2" };

function twoColumns(): WorkspaceState {
  return splitGroup(createWorkspace(["a"]), "group-1", "right", "b");
}

describe("resolveDrop for a tab", () => {
  it("joins the target group in the centre", () => {
    expect(resolveDrop(twoColumns(), TAB_B, { x: 200, y: 200 }, BOUNDS, OPTIONS)).toEqual({
      targetGroupId: "group-1",
      zone: "center",
      preview: { x: 0, y: 0, width: 804, height: 400 },
      operation: { type: "moveTab", panelId: "b", targetGroupId: "group-1" },
    });
  });

  it.each([
    ["left", { x: 50, y: 200 }, { x: 0, y: 0, width: 400, height: 400 }],
    ["right", { x: 350, y: 200 }, { x: 404, y: 0, width: 400, height: 400 }],
    ["top", { x: 200, y: 30 }, { x: 0, y: 0, width: 804, height: 198 }],
    ["bottom", { x: 200, y: 370 }, { x: 0, y: 202, width: 804, height: 198 }],
  ] as const)("splits the target at the %s edge and previews the new tile", (edge, point, preview) => {
    expect(resolveDrop(twoColumns(), TAB_B, point, BOUNDS, OPTIONS)).toEqual({
      targetGroupId: "group-1",
      zone: edge,
      preview,
      operation: { type: "moveTabToEdge", panelId: "b", targetGroupId: "group-1", edge },
    });
  });

  it("previews exactly the tile the confirmed drop creates", () => {
    const state = twoColumns();
    const drop = resolveDrop(state, TAB_B, { x: 200, y: 30 }, BOUNDS, OPTIONS);
    if (drop === null) throw new Error("expected a drop target");
    const next = applyOperation(state, drop.operation);
    expect(shape(next.root)).toEqual({
      split: "split-5",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [
        { group: "group-4", tabs: ["b"], active: "b" },
        { group: "group-1", tabs: ["a"], active: "a" },
      ],
    });
    expect(boxes(computeLayout(next, BOUNDS, OPTIONS))).toEqual({
      "group-4": [0, 0, 804, 198],
      "split-5#0": [0, 198, 804, 4],
      "group-1": [0, 202, 804, 198],
    });
  });

  it("uses the left edge where two edge zones meet in a corner", () => {
    expect(resolveDrop(twoColumns(), TAB_B, { x: 10, y: 10 }, BOUNDS, OPTIONS)?.zone).toBe("left");
    expect(resolveDrop(twoColumns(), TAB_B, { x: 20, y: 10 }, BOUNDS, OPTIONS)?.zone).toBe("top");
  });

  it("starts the centre zone a quarter of the tile away from each edge", () => {
    expect(resolveDrop(twoColumns(), TAB_B, { x: 99, y: 200 }, BOUNDS, OPTIONS)?.zone).toBe("left");
    expect(resolveDrop(twoColumns(), TAB_B, { x: 100, y: 200 }, BOUNDS, OPTIONS)?.zone).toBe("center");
    expect(resolveDrop(twoColumns(), TAB_B, { x: 300, y: 200 }, BOUNDS, OPTIONS)?.zone).toBe("center");
    expect(resolveDrop(twoColumns(), TAB_B, { x: 301, y: 200 }, BOUNDS, OPTIONS)?.zone).toBe("right");
  });

  it("has no target on its own group unless another tab stays behind", () => {
    const state = twoColumns();
    expect(resolveDrop(state, TAB_B, { x: 604, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, TAB_B, { x: 420, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    const twoTabs = addTab(state, "group-2", "c");
    expect(resolveDrop(twoTabs, TAB_B, { x: 604, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(twoTabs, TAB_B, { x: 420, y: 200 }, BOUNDS, OPTIONS)).toEqual({
      targetGroupId: "group-2",
      zone: "left",
      // Three columns share 796 px: 398 | 199 | 199.
      preview: { x: 402, y: 0, width: 199, height: 400 },
      operation: { type: "moveTabToEdge", panelId: "b", targetGroupId: "group-2", edge: "left" },
    });
  });
});

describe("resolveDrop for a group header", () => {
  it("swaps with the target in the centre", () => {
    expect(resolveDrop(twoColumns(), HEADER_2, { x: 200, y: 200 }, BOUNDS, OPTIONS)).toEqual({
      targetGroupId: "group-1",
      zone: "center",
      preview: { x: 0, y: 0, width: 400, height: 400 },
      operation: { type: "swapGroups", groupId: "group-2", targetGroupId: "group-1" },
    });
  });

  it("moves the whole group to an edge of the target", () => {
    expect(resolveDrop(twoColumns(), HEADER_2, { x: 200, y: 370 }, BOUNDS, OPTIONS)).toEqual({
      targetGroupId: "group-1",
      zone: "bottom",
      preview: { x: 0, y: 202, width: 804, height: 198 },
      operation: { type: "moveGroup", groupId: "group-2", targetGroupId: "group-1", edge: "bottom" },
    });
  });

  it("has no target on its own tile", () => {
    expect(resolveDrop(twoColumns(), HEADER_2, { x: 604, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(twoColumns(), HEADER_2, { x: 420, y: 10 }, BOUNDS, OPTIONS)).toBeNull();
  });
});

describe("resolveDrop without a target", () => {
  it("returns null on a divider, outside the work area and for unknown sources", () => {
    const state = twoColumns();
    expect(resolveDrop(state, TAB_B, { x: 401, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, TAB_B, { x: -1, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, TAB_B, { x: 804, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, TAB_B, { x: 200, y: 400 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, TAB_B, { x: Number.NaN, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, { kind: "tab", panelId: "x" }, { x: 200, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, { kind: "group", groupId: "group-9" }, { x: 200, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
  });

  it("offers only the visible tile while another one is maximized", () => {
    const state = maximizeGroup(twoColumns(), "group-1");
    expect(resolveDrop(state, { kind: "group", groupId: "group-1" }, { x: 700, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
    expect(resolveDrop(state, { kind: "tab", panelId: "a" }, { x: 700, y: 200 }, BOUNDS, OPTIONS)).toBeNull();
  });
});
