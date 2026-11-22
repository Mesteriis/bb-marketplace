// A linked block: a parent tile and the tiles of its children kept together.
// The parent-child relation is supplied by the caller (`ParentOf`); nothing
// here stores it. Like the other document operations, these change only what
// is placed: nothing is opened or ended.
import type { Edge } from "../layout/index.ts";
import { activateTab, closeTab, findGroup, findGroupOfPanel, listGroups, moveGroup, splitGroup } from "../layout/index.ts";
import type { WorkspaceDocument, WorkspacePanel } from "./document.ts";
import { activeLayout, placedPanelIds } from "./document.ts";
import type { WorkspaceChange } from "./operations.ts";
import { addPanelToGroup, changeActiveLayout, dropUnusedPanels, registerPanel } from "./operations.ts";

/** Maps a child panel id to the id of its parent panel; `undefined` for a panel that is no child. */
export type ParentOf = (panelId: string) => string | undefined;

/** Children that get a tile of their own below the parent's right side; further children become tabs of the last one. */
export const BLOCK_SIDE_LIMIT = 3;

/** The children of a parent placed in the open layout, in placement order (tile order, then tab order). */
export function blockChildren(document: WorkspaceDocument, parentPanelId: string, parentOf: ParentOf): string[] {
  const { root } = activeLayout(document).workspace;
  return listGroups(root).flatMap((group) => group.tabs).filter((panelId) => parentOf(panelId) === parentPanelId);
}

/**
 * Places a child of the parent in the open layout. The first child gets a
 * tile right of the parent, the next ones tiles below the previous child,
 * and past `BLOCK_SIDE_LIMIT` a child becomes a tab of the last child's tile.
 * A child that is already placed is only shown and focused.
 */
export function placeInBlock(
  document: WorkspaceDocument, parentPanelId: string, panelId: string, panel: WorkspacePanel, parentOf: ParentOf,
): WorkspaceChange {
  const { root } = activeLayout(document).workspace;
  if (findGroupOfPanel(root, parentPanelId) === undefined) return { ok: false, reason: "not-placed" };
  if (placedPanelIds(activeLayout(document)).includes(panelId)) {
    return changeActiveLayout(document, (workspace) => activateTab(workspace, panelId));
  }
  const children = blockChildren(document, parentPanelId, parentOf);
  const last = children.length === 0 ? undefined : findGroupOfPanel(root, children[children.length - 1]);
  if (last !== undefined && children.length >= BLOCK_SIDE_LIMIT) return addPanelToGroup(document, last.id, panelId, panel);
  const registered = registerPanel(document, panelId, panel);
  if (!registered.ok) return registered;
  const target = last ?? findGroupOfPanel(root, parentPanelId);
  if (target === undefined) return { ok: false, reason: "not-placed" };
  const edge: Edge = last === undefined ? "right" : "bottom";
  return changeActiveLayout(registered.document, (workspace) => splitGroup(workspace, target.id, edge, panelId));
}

/**
 * Takes the parent and all its placed children out of the open layout, a
 * child wherever it has been moved to. Only placements go; a reference stays
 * while another layout places the panel or a live instance shows it.
 */
export function closeBlock(
  document: WorkspaceDocument, parentPanelId: string, parentOf: ParentOf, live: ReadonlySet<string>,
): WorkspaceChange {
  const placed = placedPanelIds(activeLayout(document));
  const removed = [...(placed.includes(parentPanelId) ? [parentPanelId] : []), ...blockChildren(document, parentPanelId, parentOf)];
  if (removed.length === 0) return { ok: false, reason: "not-placed" };
  const changed = changeActiveLayout(document, (workspace) => removed.reduce(closeTab, workspace));
  return changed.ok ? { ok: true, document: dropUnusedPanels(changed.document, live) } : changed;
}

/**
 * Moves the parent's tile to an edge of another tile and puts the children
 * back beside it in their former order. A target inside the block itself, or
 * an unknown group, changes nothing.
 */
export function moveBlock(
  document: WorkspaceDocument, parentGroupId: string, targetGroupId: string, edge: Edge, parentOf: ParentOf,
): WorkspaceChange {
  const { root } = activeLayout(document).workspace;
  const parentGroup = findGroup(root, parentGroupId);
  if (parentGroup === undefined || parentGroup.activeTab === null) return { ok: false, reason: "unknown-group" };
  const parentPanelId = parentGroup.activeTab;
  const children = blockChildren(document, parentPanelId, parentOf);
  const inside = new Set([parentGroupId, ...children.flatMap((child) => findGroupOfPanel(root, child)?.id ?? [])]);
  if (inside.has(targetGroupId) || findGroup(root, targetGroupId) === undefined) return { ok: true, document };
  const lifted = changeActiveLayout(document, (workspace) => children.reduce(closeTab, workspace));
  if (!lifted.ok) return lifted;
  const moved = changeActiveLayout(lifted.document, (workspace) => moveGroup(workspace, parentGroupId, targetGroupId, edge));
  if (!moved.ok) return moved;
  let current = moved.document;
  for (const child of children) {
    const placed = placeInBlock(current, parentPanelId, child, document.panels[child], parentOf);
    if (!placed.ok) return placed;
    current = placed.document;
  }
  return { ok: true, document: current };
}
