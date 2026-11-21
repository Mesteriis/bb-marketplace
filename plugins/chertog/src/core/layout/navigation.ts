// Keyboard equivalents of the pointer gestures: move the focus, a group or a
// tab towards a side. Neighbours are found from the shares alone, so the
// result does not depend on the size of the work area.
import type { Direction, Edge, LayoutNode, WorkspaceState } from "./model.ts";
import { findGroupOfPanel } from "./model.ts";
import { focusGroup, moveTab, moveTabToEdge, swapGroups } from "./operations.ts";

/** A group's place in the unit square, dividers ignored. */
interface Box {
  readonly groupId: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const TOUCH = 1e-9;

const EDGE_OF: Record<Direction, Edge> = { left: "left", right: "right", up: "top", down: "bottom" };

function boxesOf(node: LayoutNode, left: number, top: number, right: number, bottom: number, out: Box[]): Box[] {
  if (node.kind === "group") {
    out.push({ groupId: node.id, left, top, right, bottom });
    return out;
  }
  const horizontal = node.direction === "row";
  const origin = horizontal ? left : top;
  const length = horizontal ? right - left : bottom - top;
  let share = 0;
  let start = origin;
  node.children.forEach((child, index) => {
    share += node.sizes[index];
    // The last child ends on its parent's edge exactly, so neighbours across
    // nested splits share the very same coordinate.
    const end = index === node.children.length - 1 ? (horizontal ? right : bottom) : origin + length * share;
    if (horizontal) boxesOf(child, start, top, end, bottom, out);
    else boxesOf(child, left, start, right, end, out);
    start = end;
  });
  return out;
}

/**
 * The group next to `groupId` on the given side: it touches that side and
 * shares the longest stretch of it; of equals, the first in reading order.
 */
export function neighborInDirection(root: LayoutNode, groupId: string, direction: Direction): string | undefined {
  const boxes = boxesOf(root, 0, 0, 1, 1, []);
  const from = boxes.find((box) => box.groupId === groupId);
  if (from === undefined) return undefined;
  const horizontal = direction === "left" || direction === "right";
  let best: string | undefined;
  let bestShared = TOUCH;
  for (const box of boxes) {
    if (box === from) continue;
    const gap =
      direction === "left"
        ? from.left - box.right
        : direction === "right"
          ? box.left - from.right
          : direction === "up"
            ? from.top - box.bottom
            : box.top - from.bottom;
    if (Math.abs(gap) > TOUCH) continue;
    const shared = horizontal
      ? Math.min(from.bottom, box.bottom) - Math.max(from.top, box.top)
      : Math.min(from.right, box.right) - Math.max(from.left, box.left);
    if (shared > bestShared + TOUCH) {
      best = box.groupId;
      bestShared = shared;
    }
  }
  return best;
}

/** Focuses the tile next to the focused one. Nothing changes at the edge or while a group is maximized. */
export function focusInDirection(state: WorkspaceState, direction: Direction): WorkspaceState {
  if (state.maximizedGroupId !== null) return state;
  const neighbor = neighborInDirection(state.root, state.focusedGroupId, direction);
  return neighbor === undefined ? state : focusGroup(state, neighbor);
}

/** Swaps a group with its neighbour on the given side, as a header dropped on that tile's centre does. */
export function moveGroupInDirection(state: WorkspaceState, groupId: string, direction: Direction): WorkspaceState {
  const neighbor = neighborInDirection(state.root, groupId, direction);
  return neighbor === undefined ? state : swapGroups(state, groupId, neighbor);
}

/**
 * Moves a tab into the neighbouring group on the given side. Without a
 * neighbour there, a tab that is not alone in its group moves out into a new
 * tile on that side of it.
 */
export function moveTabInDirection(state: WorkspaceState, panelId: string, direction: Direction): WorkspaceState {
  const group = findGroupOfPanel(state.root, panelId);
  if (group === undefined) return state;
  const neighbor = neighborInDirection(state.root, group.id, direction);
  if (neighbor !== undefined) return moveTab(state, panelId, neighbor);
  return moveTabToEdge(state, panelId, group.id, EDGE_OF[direction]);
}
