// Random sequences of every operation. After each step the tree must be
// normalized and the geometry must tile the work area pixel for pixel. The
// checks are written here independently of the code under test: the tree is
// inspected by hand and the geometry is painted onto a pixel grid.
import { describe, expect, it } from "vitest";
import {
  addTab,
  applyOperation,
  closeGroup,
  closeTab,
  computeLayout,
  createWorkspace,
  focusInDirection,
  maximizeGroup,
  moveGroup,
  moveGroupInDirection,
  moveTab,
  moveTabInDirection,
  moveTabToEdge,
  resizeDivider,
  resolveDrop,
  restoreMaximized,
  splitGroup,
  swapGroups,
} from "../../../src/core/layout/index.ts";
import type { Direction, Edge, GroupNode, LayoutNode, LayoutOptions, Rect, WorkspaceState } from "../../../src/core/layout/index.ts";
import { coverageProblems } from "./support.ts";

const EDGES: readonly Edge[] = ["left", "right", "top", "bottom"];
const DIRECTIONS: readonly Direction[] = ["left", "right", "up", "down"];
const OPTIONS: LayoutOptions = { dividerSize: 3, minTileWidth: 12, minTileHeight: 9, compactWidth: 40, dropEdgeFraction: 0.25 };

/** mulberry32: a small seeded generator, so a failing sequence can be replayed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function groupsOf(node: LayoutNode): GroupNode[] {
  return node.kind === "group" ? [node] : node.children.flatMap(groupsOf);
}

function treeProblems(state: WorkspaceState): string[] {
  const problems: string[] = [];
  const ids: string[] = [];
  const visit = (node: LayoutNode, parent: LayoutNode | null): void => {
    ids.push(node.id);
    if (node.kind === "group") {
      if (node.tabs.length === 0 && parent !== null) problems.push("empty group " + node.id);
      if (node.tabs.length === 0 ? node.activeTab !== null : node.activeTab === null || !node.tabs.includes(node.activeTab)) {
        problems.push("bad active tab in " + node.id);
      }
      return;
    }
    if (node.children.length < 2) problems.push("split " + node.id + " has " + node.children.length + " children");
    if (node.sizes.length !== node.children.length) problems.push("split " + node.id + " sizes do not match children");
    if (node.sizes.some((size) => !(size > 0))) problems.push("split " + node.id + " has a non-positive share");
    const total = node.sizes.reduce((sum, size) => sum + size, 0);
    if (Math.abs(total - 1) > 1e-6) problems.push("split " + node.id + " shares sum to " + total);
    if (parent !== null && parent.kind === "split" && parent.direction === node.direction) {
      problems.push("split " + node.id + " repeats its parent's direction");
    }
    for (const child of node.children) visit(child, node);
  };
  visit(state.root, null);
  const groups = groupsOf(state.root);
  const tabs = groups.flatMap((group) => group.tabs);
  if (new Set(ids).size !== ids.length) problems.push("duplicate node id");
  if (new Set(tabs).size !== tabs.length) problems.push("a panel is placed twice");
  if (!groups.some((group) => group.id === state.focusedGroupId)) problems.push("focus points at a missing group");
  if (state.maximizedGroupId !== null && !groups.some((group) => group.id === state.maximizedGroupId)) {
    problems.push("maximize points at a missing group");
  }
  return problems;
}

function step(state: WorkspaceState, bounds: Rect, random: () => number, fresh: () => string): [string, WorkspaceState] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const groups = groupsOf(state.root);
  const group = pick(groups);
  const other = pick(groups);
  const tabs = groups.flatMap((item) => item.tabs);
  const tab = tabs.length > 0 ? pick(tabs) : "none";
  const point = { x: bounds.x + Math.floor(random() * bounds.width), y: bounds.y + Math.floor(random() * bounds.height) };
  switch (Math.floor(random() * 16)) {
    case 0:
    case 1:
    case 2:
      return ["splitGroup", splitGroup(state, group.id, pick(EDGES), fresh())];
    case 3:
      return ["addTab", addTab(state, group.id, fresh())];
    case 4:
      return ["moveTab", moveTab(state, tab, other.id, random() < 0.5 ? undefined : Math.floor(random() * 4))];
    case 5:
      return ["moveTabToEdge", moveTabToEdge(state, tab, other.id, pick(EDGES))];
    case 6:
      return ["moveGroup", moveGroup(state, group.id, other.id, pick(EDGES))];
    case 7:
      return ["swapGroups", swapGroups(state, group.id, other.id)];
    case 8:
      return ["closeTab", closeTab(state, tab)];
    case 9:
      return ["closeGroup", closeGroup(state, group.id)];
    case 10: {
      const dividers = computeLayout(state, bounds, OPTIONS).dividers;
      if (dividers.length === 0) return ["resizeDivider", state];
      const divider = pick(dividers);
      const delta = Math.floor(random() * 121) - 60;
      return ["resizeDivider", resizeDivider(state, divider.splitId, divider.index, delta, bounds, OPTIONS)];
    }
    case 11:
      return ["maximize", random() < 0.5 ? maximizeGroup(state, group.id) : restoreMaximized(state)];
    case 12:
      return ["focusInDirection", focusInDirection(state, pick(DIRECTIONS))];
    case 13:
      return ["moveGroupInDirection", moveGroupInDirection(state, group.id, pick(DIRECTIONS))];
    case 14:
      return ["moveTabInDirection", moveTabInDirection(state, tab, pick(DIRECTIONS))];
    default: {
      const source = random() < 0.5 ? ({ kind: "tab", panelId: tab } as const) : ({ kind: "group", groupId: group.id } as const);
      const drop = resolveDrop(state, source, point, bounds, OPTIONS);
      if (drop === null) return ["drop", state];
      const next = applyOperation(state, drop.operation);
      const moved =
        source.kind === "group" ? source.groupId : groupsOf(next.root).find((item) => item.tabs.includes(source.panelId))?.id;
      const shown = computeLayout(next, bounds, OPTIONS).groups.find((item) => item.groupId === moved);
      // The preview is the place the dragged thing really lands on.
      if (shown !== undefined) expect(drop.preview).toEqual(shown.rect);
      return ["drop", next];
    }
  }
}

describe("random operation sequences", () => {
  it("keep the tree normalized and tile the work area exactly", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = generator(seed);
      let counter = 0;
      const fresh = (): string => "p" + (counter += 1);
      let state = createWorkspace(seed % 3 === 0 ? [] : [fresh()]);
      const trail: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        // A new work area on every step: window and sidebar change between gestures.
        const bounds = {
          x: Math.floor(random() * 30),
          y: Math.floor(random() * 30),
          width: 1 + Math.floor(random() * 220),
          height: 1 + Math.floor(random() * 160),
        };
        const [name, next] = step(state, bounds, random, fresh);
        trail.push(name);
        state = next;
        const context = "seed " + seed + " after " + trail.join(", ");
        expect(treeProblems(state), context).toEqual([]);
        const geometry = computeLayout(state, bounds, OPTIONS);
        expect(coverageProblems(geometry, bounds), context).toEqual([]);
        if (geometry.mode !== "tiled") expect(geometry.groups, context).toHaveLength(1);
      }
    }
  });

  it("resize moves one boundary: everything outside the two dragged children stays put", () => {
    const bounds = { x: 7, y: 11, width: 900, height: 700 };
    const find = (node: LayoutNode, id: string): LayoutNode | undefined =>
      node.id === id ? node : node.kind === "split" ? node.children.map((child) => find(child, id)).find(Boolean) : undefined;
    const idsUnder = (node: LayoutNode): string[] => (node.kind === "group" ? [node.id] : [node.id, ...node.children.flatMap(idsUnder)]);
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = generator(1000 + seed);
      let counter = 0;
      const fresh = (): string => "p" + (counter += 1);
      let state = createWorkspace([fresh()]);
      for (let index = 0; index < 6; index += 1) {
        const groups = groupsOf(state.root);
        const target = groups[Math.floor(random() * groups.length)];
        state = splitGroup(state, target.id, EDGES[Math.floor(random() * EDGES.length)], fresh());
      }
      for (let index = 0; index < 12; index += 1) {
        const before = computeLayout(state, bounds, OPTIONS);
        const divider = before.dividers[Math.floor(random() * before.dividers.length)];
        const delta = Math.floor(random() * 401) - 200;
        const next = resizeDivider(state, divider.splitId, divider.index, delta, bounds, OPTIONS);
        const after = computeLayout(next, bounds, OPTIONS);
        expect(coverageProblems(after, bounds)).toEqual([]);

        const split = find(state.root, divider.splitId);
        if (split === undefined || split.kind !== "split") throw new Error("the dragged split is missing");
        const dragged = new Set([...idsUnder(split.children[divider.index]), ...idsUnder(split.children[divider.index + 1])]);
        for (const group of before.groups) {
          if (dragged.has(group.groupId)) continue;
          expect(after.groups.find((item) => item.groupId === group.groupId)).toEqual(group);
        }
        for (const other of before.dividers) {
          if (dragged.has(other.splitId) || (other.splitId === divider.splitId && other.index === divider.index)) continue;
          expect(after.dividers.find((item) => item.splitId === other.splitId && item.index === other.index)).toEqual(other);
        }

        const moved = after.dividers.find((item) => item.splitId === divider.splitId && item.index === divider.index);
        if (moved === undefined) throw new Error("the dragged divider disappeared");
        const shift = divider.direction === "row" ? moved.rect.x - divider.rect.x : moved.rect.y - divider.rect.y;
        // Never further than the pointer went, and never the other way.
        expect(Math.abs(shift)).toBeLessThanOrEqual(Math.abs(delta));
        expect(shift * delta).toBeGreaterThanOrEqual(0);
        state = next;
      }
    }
  });
});
