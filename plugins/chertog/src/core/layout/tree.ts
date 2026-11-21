// Tree surgery shared by the operations: replace, insert, normalize. Nothing
// here is exported from the layout module.
import type { Edge, GroupNode, LayoutNode, SplitDirection, WorkspaceState } from "./model.ts";
import { listGroups } from "./model.ts";

/** Hands out node ids for one operation; `next` goes back into the state. */
export interface IdSource {
  next: number;
}

export function newId(ids: IdSource, kind: LayoutNode["kind"]): string {
  const id = kind + "-" + ids.next;
  ids.next += 1;
  return id;
}

/** Shares may drift by a few ulps through arithmetic; within this they count as summing to 1. */
const SHARE_TOLERANCE = 1e-9;

/**
 * The tree with every node passed through `replace`, children first. Nodes
 * `replace` returns unchanged keep their identity, and so does every subtree
 * without a change in it.
 */
export function mapNodes(node: LayoutNode, replace: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.kind === "group") return replace(node);
  let changed = false;
  const children = node.children.map((child) => {
    const mapped = mapNodes(child, replace);
    if (mapped !== child) changed = true;
    return mapped;
  });
  return replace(changed ? { ...node, children } : node);
}

export function replaceGroup(root: LayoutNode, group: GroupNode): LayoutNode {
  return mapNodes(root, (node) => (node.kind === "group" && node.id === group.id ? group : node));
}

/** The group with its tabs taken away; `normalize` then removes it from the tree. */
export function emptied(group: GroupNode): GroupNode {
  return { ...group, tabs: [], activeTab: null };
}

export function axisOfEdge(edge: Edge): SplitDirection {
  return edge === "left" || edge === "right" ? "row" : "column";
}

/**
 * Puts `added` at an edge of the target group. Inside a split of the same
 * direction the target shares its place half and half with a new sibling;
 * anywhere else the target becomes a new split of the two.
 */
export function insertBeside(root: LayoutNode, targetId: string, edge: Edge, added: LayoutNode, ids: IdSource): LayoutNode {
  const direction = axisOfEdge(edge);
  const before = edge === "left" || edge === "top";
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      if (node.id !== targetId) return node;
      return {
        kind: "split",
        id: newId(ids, "split"),
        direction,
        children: before ? [added, node] : [node, added],
        sizes: [0.5, 0.5],
      };
    }
    const index = node.children.findIndex((child) => child.kind === "group" && child.id === targetId);
    if (index >= 0 && node.direction === direction) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = sizes[index] / 2;
      sizes[index] = half;
      children.splice(before ? index : index + 1, 0, added);
      sizes.splice(before ? index : index + 1, 0, half);
      return { ...node, children, sizes };
    }
    let changed = false;
    const children = node.children.map((child) => {
      const visited = visit(child);
      if (visited !== child) changed = true;
      return visited;
    });
    return changed ? { ...node, children } : node;
  };
  return visit(root);
}

/**
 * The tree in normal form, or `null` when nothing is left: no empty groups, no
 * split with one child, no split nested in a split of the same direction,
 * shares summing to 1. A removed child's share goes to its siblings in
 * proportion; a split left with one child gives that child its own place.
 */
export function normalize(node: LayoutNode): LayoutNode | null {
  if (node.kind === "group") return node.tabs.length === 0 ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  let changed = false;
  node.children.forEach((child, index) => {
    const size = node.sizes[index];
    const normal = normalize(child);
    if (normal === null) {
      changed = true;
    } else if (normal.kind === "split" && normal.direction === node.direction) {
      changed = true;
      normal.children.forEach((grandchild, inner) => {
        children.push(grandchild);
        sizes.push(size * normal.sizes[inner]);
      });
    } else {
      if (normal !== child) changed = true;
      children.push(normal);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (Math.abs(total - 1) <= SHARE_TOLERANCE) return changed ? { ...node, children, sizes } : node;
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

/**
 * The group that takes over when `groupId` leaves the tree: the nearest tile
 * of the sibling before it, else of the sibling after it.
 */
export function heirOf(root: LayoutNode, groupId: string): string | undefined {
  if (root.kind === "group") return undefined;
  const index = root.children.findIndex((child) => child.kind === "group" && child.id === groupId);
  if (index < 0) {
    for (const child of root.children) {
      const heir = heirOf(child, groupId);
      if (heir !== undefined) return heir;
    }
    return undefined;
  }
  if (index > 0) return listGroups(root.children[index - 1]).at(-1)?.id;
  return listGroups(root.children[index + 1])[0]?.id;
}

/**
 * Maximize holds only while the maximized group is the focused one. A
 * maximized group hides every other tile, so focus that goes elsewhere ends
 * maximize rather than point at a tile nobody can see.
 */
export function visibleMaximized(maximizedGroupId: string | null, focusedGroupId: string): string | null {
  return maximizedGroupId === focusedGroupId ? maximizedGroupId : null;
}

/**
 * Closes an operation: normalizes the new tree, leaves one empty picker group
 * when nothing remains, keeps the focus on an existing group and maximize only
 * on the focused one.
 * `focus` lists the groups to focus in order of preference.
 */
export function settle(
  root: LayoutNode,
  ids: IdSource,
  focus: readonly (string | undefined)[],
  maximizedGroupId: string | null,
): WorkspaceState {
  const normal: LayoutNode = normalize(root) ?? { kind: "group", id: newId(ids, "group"), tabs: [], activeTab: null };
  const groups = listGroups(normal);
  const exists = (id: string | null | undefined): id is string => groups.some((group) => group.id === id);
  const focusedGroupId = focus.find(exists) ?? groups[0].id;
  return {
    root: normal,
    focusedGroupId,
    maximizedGroupId: visibleMaximized(maximizedGroupId, focusedGroupId),
    nextNodeId: ids.next,
  };
}
