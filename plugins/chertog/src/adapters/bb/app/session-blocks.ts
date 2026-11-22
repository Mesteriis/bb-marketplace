// The linked blocks of the workspace session: what hiding, closing and moving
// a parent tile does to the tiles of its children. The session keeps the
// documents and the live instances; this module decides what a block does
// with them and talks to the session only through `BlockClosePorts`.
import { closeTab, findGroup, focusGroup, type LayoutOperation, type WorkspaceState } from "../../../core/layout/index.ts";
import {
  activeLayout,
  applyLayoutOperation,
  blockChildren,
  changeActiveLayout,
  closeBlock,
  moveWithBlocks,
  placedPanelIds,
  type ParentOf,
  type WorkspaceChange,
  type WorkspaceDocument,
} from "../../../core/workspace/index.ts";

export type CloseOutcome =
  | "closed"
  | "kept"
  /** Nothing was closed: the user has to confirm first (a block, or the end of a session). */
  | "needs-confirmation";

export interface CloseOptions {
  /** The user agreed that the linked tiles of a parent close with it. */
  readonly confirmBlock?: boolean;
  /** The user agreed that a close may end a session. */
  readonly confirmEndsSession?: boolean;
}

/** Whether the open layout places children of the panel. */
export function hasBlock(document: WorkspaceDocument, panelId: string, parentOf: ParentOf): boolean {
  return blockChildren(document, panelId, parentOf).length > 0;
}

/** How many children each parent has in the open layout; parents without children are left out. */
export function linkedCounts(document: WorkspaceDocument, parentOf: ParentOf): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const panelId of Object.keys(document.panels)) {
    const count = blockChildren(document, panelId, parentOf).length;
    if (count > 0) counts[panelId] = count;
  }
  return counts;
}

/** The panels a layout operation moves that have children: the tabs of a moved tile, or the moved tab. */
function movedParents(document: WorkspaceDocument, operation: LayoutOperation, parentOf: ParentOf): string[] {
  const { root } = activeLayout(document).workspace;
  const moved = operation.type === "moveTab" || operation.type === "moveTabToEdge" ? [operation.panelId] : findGroup(root, operation.groupId)?.tabs ?? [];
  return moved.filter((panelId) => hasBlock(document, panelId, parentOf));
}

/** A layout operation that takes the children of every moved parent along; any other operation is applied as it is. */
export function applyOperationWithBlocks(document: WorkspaceDocument, operation: LayoutOperation, parentOf: ParentOf): WorkspaceChange {
  const parents = movedParents(document, operation, parentOf);
  return parents.length === 0
    ? applyLayoutOperation(document, operation)
    : moveWithBlocks(document, parents, operation.targetGroupId, parentOf, (lifted) => applyLayoutOperation(lifted, operation));
}

/**
 * A state the tile surface asks for. A keyboard move comes with its operation
 * and takes linked tiles along; a parent that leaves the layout takes its
 * children with it.
 */
export function applyStateWithBlocks(
  document: WorkspaceDocument, state: WorkspaceState, via: LayoutOperation | undefined, parentOf: ParentOf,
): WorkspaceChange {
  if (via !== undefined && movedParents(document, via, parentOf).length > 0) {
    const moved = applyOperationWithBlocks(document, via, parentOf);
    // The surface focuses the tile before it moves.
    return moved.ok ? changeActiveLayout(moved.document, (workspace) => focusGroup(workspace, state.focusedGroupId)) : moved;
  }
  const changed = changeActiveLayout(document, () => state);
  if (!changed.ok) return changed;
  const kept = new Set(placedPanelIds(activeLayout(changed.document)));
  const orphans = placedPanelIds(activeLayout(document))
    .filter((panelId) => !kept.has(panelId))
    .flatMap((panelId) => blockChildren(document, panelId, parentOf))
    .filter((child) => kept.has(child));
  return orphans.length === 0 ? changed : changeActiveLayout(changed.document, (workspace) => orphans.reduce(closeTab, workspace));
}

/** What the block close needs from the session. */
export interface BlockClosePorts {
  readonly parentOf: ParentOf;
  document(): WorkspaceDocument | null;
  /** Whether releasing the panel's view now would first need the user's confirmation. */
  needsConfirmation(panelId: string): boolean;
  /** The provider's own question before a close; `"none"` for a panel without one. */
  askClose(panelId: string): Promise<"ended" | "keep" | "hide" | "none">;
  /** Releases the panel's view and forgets its instance. */
  release(panelId: string, options: CloseOptions): Promise<CloseOutcome>;
  hide(panelId: string): void;
  change(apply: (document: WorkspaceDocument, live: ReadonlySet<string>) => WorkspaceChange): void;
}

/**
 * Closes a parent with its children, all or nothing. One question covers the
 * block (`confirmBlock`) and, through `confirmEndsSession`, any session a
 * member would end. Every member is checked, and the providers asked, before
 * any view is released; then the children go first and the parent last, and a
 * child that appeared meanwhile is closed too. Only then are the placements
 * taken out of the layout.
 */
export async function closeParentWithBlock(ports: BlockClosePorts, parent: string, options: CloseOptions): Promise<CloseOutcome> {
  if (options.confirmBlock !== true) return "needs-confirmation";
  const childrenNow = (): string[] => {
    const document = ports.document();
    return document === null ? [] : blockChildren(document, parent, ports.parentOf);
  };
  const members = [...childrenNow(), parent];
  if (options.confirmEndsSession !== true && members.some((member) => ports.needsConfirmation(member))) return "needs-confirmation";
  for (const member of members) {
    const answer = await ports.askClose(member);
    if (answer === "ended" || answer === "none") continue;
    if (answer === "hide") ports.hide(member);
    return "kept";
  }
  const released = new Set<string>();
  for (let pending = childrenNow(); pending.length > 0; pending = childrenNow().filter((child) => !released.has(child))) {
    for (const child of pending) {
      const outcome = await ports.release(child, options);
      if (outcome !== "closed") return outcome;
      released.add(child);
    }
  }
  const outcome = await ports.release(parent, options);
  if (outcome !== "closed") return outcome;
  ports.change((document, live) =>
    placedPanelIds(activeLayout(document)).includes(parent) || hasBlock(document, parent, ports.parentOf)
      ? closeBlock(document, parent, ports.parentOf, live)
      : { ok: true, document });
  return "closed";
}
