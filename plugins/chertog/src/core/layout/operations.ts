// Pure operations on a workspace. Each returns a new normalized state, or the
// very same state object when there is nothing to do: an unknown id, a drop
// on itself, a target that does not fit. Callers compare by reference.
//
// None of them closes a panel or ends a session: they only change placement.
import type { Edge, GroupNode, LayoutNode, WorkspaceState } from "./model.ts";
import { findGroup, findGroupOfPanel } from "./model.ts";
import type { IdSource } from "./tree.ts";
import { emptied, heirOf, insertBeside, mapNodes, newId, normalize, replaceGroup, settle } from "./tree.ts";

/** A placement change a drop resolves to; `applyOperation` performs it. */
export type LayoutOperation =
  | { readonly type: "moveTab"; readonly panelId: string; readonly targetGroupId: string }
  | { readonly type: "moveTabToEdge"; readonly panelId: string; readonly targetGroupId: string; readonly edge: Edge }
  | { readonly type: "moveGroup"; readonly groupId: string; readonly targetGroupId: string; readonly edge: Edge }
  | { readonly type: "swapGroups"; readonly groupId: string; readonly targetGroupId: string };

function idsOf(state: WorkspaceState): IdSource {
  return { next: state.nextNodeId };
}

function placedPanel(state: WorkspaceState, panelId: string): boolean {
  return findGroupOfPanel(state.root, panelId) !== undefined;
}

/** The group without the tab; the tab that slides into its position becomes active. */
function withoutTab(group: GroupNode, panelId: string): GroupNode {
  const index = group.tabs.indexOf(panelId);
  const tabs = group.tabs.filter((tab) => tab !== panelId);
  const activeTab = group.activeTab === panelId ? (tabs[index] ?? tabs[index - 1] ?? null) : group.activeTab;
  return { ...group, tabs, activeTab };
}

function withTab(group: GroupNode, panelId: string, index: number | undefined): GroupNode {
  const tabs = [...group.tabs];
  const position = index === undefined || !Number.isFinite(index) ? tabs.length : Math.min(Math.max(Math.trunc(index), 0), tabs.length);
  tabs.splice(position, 0, panelId);
  return { ...group, tabs, activeTab: panelId };
}

/** The tree after a group gave away a tab or everything; never empty while another group remains. */
function rootWithout(root: LayoutNode, reduced: GroupNode): LayoutNode | null {
  return normalize(replaceGroup(root, reduced));
}

/** Opens a new panel as the last tab of a group, active and focused. */
export function addTab(state: WorkspaceState, groupId: string, panelId: string): WorkspaceState {
  const group = findGroup(state.root, groupId);
  if (group === undefined || placedPanel(state, panelId)) return state;
  return settle(replaceGroup(state.root, withTab(group, panelId, undefined)), idsOf(state), [groupId], state.maximizedGroupId);
}

/**
 * Opens a new panel in a new tile at an edge of the target group. The empty
 * picker group does not stay beside it: the new tile replaces it.
 */
export function splitGroup(state: WorkspaceState, targetGroupId: string, edge: Edge, panelId: string): WorkspaceState {
  if (findGroup(state.root, targetGroupId) === undefined || placedPanel(state, panelId)) return state;
  const ids = idsOf(state);
  const added: GroupNode = { kind: "group", id: newId(ids, "group"), tabs: [panelId], activeTab: panelId };
  return settle(insertBeside(state.root, targetGroupId, edge, added, ids), ids, [added.id], null);
}

/**
 * Moves a tab into a group, at `index` or at the end, and makes it active
 * there. Inside its own group this reorders; without an index, or when the
 * order would not change, the state is returned as is. A source group left
 * without tabs disappears and its neighbours take the place.
 */
export function moveTab(state: WorkspaceState, panelId: string, targetGroupId: string, index?: number): WorkspaceState {
  const source = findGroupOfPanel(state.root, panelId);
  const target = findGroup(state.root, targetGroupId);
  if (source === undefined || target === undefined) return state;
  if (source.id === target.id) {
    if (index === undefined) return state;
    const reordered = withTab(withoutTab(source, panelId), panelId, index);
    if (reordered.tabs.every((tab, position) => tab === source.tabs[position])) return state;
    return settle(replaceGroup(state.root, reordered), idsOf(state), [source.id], state.maximizedGroupId);
  }
  const reduced = withoutTab(source, panelId);
  const grown = withTab(target, panelId, index);
  const root = mapNodes(state.root, (node) => (node.id === source.id ? reduced : node.id === target.id ? grown : node));
  return settle(root, idsOf(state), [target.id], state.maximizedGroupId);
}

/**
 * Moves a tab out into a new tile at an edge of the target group. The only
 * tab of a group dropped on an edge of that same group changes nothing.
 */
export function moveTabToEdge(state: WorkspaceState, panelId: string, targetGroupId: string, edge: Edge): WorkspaceState {
  const source = findGroupOfPanel(state.root, panelId);
  if (source === undefined || findGroup(state.root, targetGroupId) === undefined) return state;
  if (source.id === targetGroupId && source.tabs.length === 1) return state;
  const remaining = rootWithout(state.root, withoutTab(source, panelId));
  if (remaining === null) return state;
  const ids = idsOf(state);
  const added: GroupNode = { kind: "group", id: newId(ids, "group"), tabs: [panelId], activeTab: panelId };
  return settle(insertBeside(remaining, targetGroupId, edge, added, ids), ids, [added.id], null);
}

/** Moves a whole group, tabs and id included, to an edge of another group. */
export function moveGroup(state: WorkspaceState, groupId: string, targetGroupId: string, edge: Edge): WorkspaceState {
  const source = findGroup(state.root, groupId);
  if (source === undefined || groupId === targetGroupId || findGroup(state.root, targetGroupId) === undefined) return state;
  const remaining = rootWithout(state.root, emptied(source));
  if (remaining === null) return state;
  const ids = idsOf(state);
  return settle(insertBeside(remaining, targetGroupId, edge, source, ids), ids, [groupId], null);
}

/** Exchanges the places of two groups; each place keeps its share. */
export function swapGroups(state: WorkspaceState, groupId: string, otherGroupId: string): WorkspaceState {
  const first = findGroup(state.root, groupId);
  const second = findGroup(state.root, otherGroupId);
  if (first === undefined || second === undefined || first === second) return state;
  const root = mapNodes(state.root, (node) => (node === first ? second : node === second ? first : node));
  return settle(root, idsOf(state), [state.focusedGroupId], null);
}

/** Removes a tab from the layout. Its group goes with its last tab. */
export function closeTab(state: WorkspaceState, panelId: string): WorkspaceState {
  const group = findGroupOfPanel(state.root, panelId);
  if (group === undefined) return state;
  const focus = [state.focusedGroupId, heirOf(state.root, group.id)];
  return settle(replaceGroup(state.root, withoutTab(group, panelId)), idsOf(state), focus, state.maximizedGroupId);
}

/**
 * Removes a group with all its tabs; its neighbours take the place at once.
 * Closing the last group leaves one empty picker group, and closing that
 * picker changes nothing.
 */
export function closeGroup(state: WorkspaceState, groupId: string): WorkspaceState {
  const group = findGroup(state.root, groupId);
  if (group === undefined || (group === state.root && group.tabs.length === 0)) return state;
  const focus = [state.focusedGroupId === groupId ? undefined : state.focusedGroupId, heirOf(state.root, groupId)];
  return settle(replaceGroup(state.root, emptied(group)), idsOf(state), focus, state.maximizedGroupId);
}

export function focusGroup(state: WorkspaceState, groupId: string): WorkspaceState {
  if (state.focusedGroupId === groupId || findGroup(state.root, groupId) === undefined) return state;
  return { ...state, focusedGroupId: groupId };
}

/** Shows a tab in its group and focuses that group. */
export function activateTab(state: WorkspaceState, panelId: string): WorkspaceState {
  const group = findGroupOfPanel(state.root, panelId);
  if (group === undefined) return state;
  if (group.activeTab === panelId) return focusGroup(state, group.id);
  return { ...state, root: replaceGroup(state.root, { ...group, activeTab: panelId }), focusedGroupId: group.id };
}

/** Shows one group on the whole surface and focuses it. The tree, and so every share, is untouched. */
export function maximizeGroup(state: WorkspaceState, groupId: string): WorkspaceState {
  if (state.maximizedGroupId === groupId || findGroup(state.root, groupId) === undefined) return state;
  return { ...state, maximizedGroupId: groupId, focusedGroupId: groupId };
}

export function restoreMaximized(state: WorkspaceState): WorkspaceState {
  return state.maximizedGroupId === null ? state : { ...state, maximizedGroupId: null };
}

export function toggleMaximize(state: WorkspaceState, groupId: string): WorkspaceState {
  return state.maximizedGroupId === groupId ? restoreMaximized(state) : maximizeGroup(state, groupId);
}

export function applyOperation(state: WorkspaceState, operation: LayoutOperation): WorkspaceState {
  switch (operation.type) {
    case "moveTab":
      return moveTab(state, operation.panelId, operation.targetGroupId);
    case "moveTabToEdge":
      return moveTabToEdge(state, operation.panelId, operation.targetGroupId, operation.edge);
    case "moveGroup":
      return moveGroup(state, operation.groupId, operation.targetGroupId, operation.edge);
    case "swapGroups":
      return swapGroups(state, operation.groupId, operation.targetGroupId);
  }
}
