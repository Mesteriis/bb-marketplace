// The layout tree of a Chertog workspace: what is placed where. It refers to
// panels only by their string id and knows nothing about what a panel shows.

/** `row` lays children out left to right, `column` top to bottom. */
export type SplitDirection = "row" | "column";

/** A side of a tile: where a split puts the new tile, or where a drop lands. */
export type Edge = "left" | "right" | "top" | "bottom";

/** A keyboard direction for moving the focus, a group or a tab. */
export type Direction = "left" | "right" | "up" | "down";

/**
 * A tile: a list of tabs with one of them active. A group without tabs is the
 * content picker; the tree holds one only as its sole node.
 */
export interface GroupNode {
  readonly kind: "group";
  readonly id: string;
  /** Panel ids in tab order. A panel is placed at most once in a tree. */
  readonly tabs: readonly string[];
  /** One of `tabs`, or `null` for the empty picker group. */
  readonly activeTab: string | null;
}

/**
 * Two or more children side by side. `sizes[i]` is the share of child `i` in
 * the space left after the dividers; the shares are positive and sum to 1. A
 * child is never a split of the same direction.
 */
export interface SplitNode {
  readonly kind: "split";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: readonly LayoutNode[];
  readonly sizes: readonly number[];
}

export type LayoutNode = GroupNode | SplitNode;

/**
 * One workspace surface. Node ids come from `nextNodeId`, so they are stable:
 * a node keeps its id wherever it moves, and an id is never reused.
 */
export interface WorkspaceState {
  readonly root: LayoutNode;
  readonly focusedGroupId: string;
  /**
   * The group shown alone on the whole surface; the tree keeps its shares for
   * restore. When set it is the focused group: focus never rests on a hidden tile.
   */
  readonly maximizedGroupId: string | null;
  readonly nextNodeId: number;
}

/** A workspace with one group holding the given panels; with none it is the content picker. */
export function createWorkspace(panelIds: readonly string[] = []): WorkspaceState {
  const tabs = [...new Set(panelIds)];
  return {
    root: { kind: "group", id: "group-1", tabs, activeTab: tabs[0] ?? null },
    focusedGroupId: "group-1",
    maximizedGroupId: null,
    nextNodeId: 2,
  };
}

/** Every group of the tree, in reading order: left to right, top to bottom. */
export function listGroups(node: LayoutNode): GroupNode[] {
  return node.kind === "group" ? [node] : node.children.flatMap(listGroups);
}

export function findGroup(node: LayoutNode, groupId: string): GroupNode | undefined {
  return listGroups(node).find((group) => group.id === groupId);
}

/** The group that holds the panel as one of its tabs. */
export function findGroupOfPanel(node: LayoutNode, panelId: string): GroupNode | undefined {
  return listGroups(node).find((group) => group.tabs.includes(panelId));
}

export function findSplit(node: LayoutNode, splitId: string): SplitNode | undefined {
  if (node.kind === "group") return undefined;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found !== undefined) return found;
  }
  return undefined;
}
