// Where the workspace document is kept, and the rule for two windows that
// save the same workspace: a save names the revision it was made from, a
// stale save is refused with the stored document, and the refused window
// merges its work into that document and saves again.
import type { LayoutNode } from "../layout/index.ts";
import { panelRefKey } from "../panels/index.ts";
import type { NamedLayout, WorkspaceDocument, WorkspacePanel } from "./document.ts";
import { firstProblem, initialDocument, placedPanelIds, workspaceDocumentSchema } from "./document.ts";
import type { DroppedPart, WorkspaceReadResult } from "./read.ts";

export type WorkspaceSaveResult =
  /** Stored. `document` carries the new revision and is the base of the next save. */
  | { readonly status: "saved"; readonly document: WorkspaceDocument }
  /** Another save came first. `current` is what storage holds now, `null` when it holds nothing. */
  | { readonly status: "conflict"; readonly current: WorkspaceDocument | null }
  /** The document breaks the schema, for example it carries a credential. Nothing was stored. */
  | { readonly status: "rejected"; readonly reason: string };

/** The storage of one workspace. An adapter implements it over the host's storage with `decideSave`. */
export interface WorkspaceStore {
  load(): Promise<WorkspaceReadResult>;
  /**
   * Stores the document if storage still holds `expectedRevision`: the
   * revision of the document this one was made from, 0 for the first save.
   * The check and the write are one step for every window of the workspace.
   */
  save(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult>;
}

/**
 * The save rule every store applies. `stored` is the document storage holds
 * now, `null` for none. A document that fails the schema is rejected; a save
 * made from another revision than the stored one is a conflict; otherwise
 * the document is stored with the next revision.
 */
export function decideSave(stored: WorkspaceDocument | null, document: WorkspaceDocument, expectedRevision: number): WorkspaceSaveResult {
  const parsed = workspaceDocumentSchema.safeParse(document);
  if (!parsed.success) return { status: "rejected", reason: firstProblem(parsed.error) };
  if ((stored?.revision ?? 0) !== expectedRevision) return { status: "conflict", current: stored };
  return { status: "saved", document: { ...parsed.data, revision: expectedRevision + 1 } };
}

/** Whether two values of plain JSON data are equal, whatever the order of their keys. */
function sameData(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (typeof first !== "object" || typeof second !== "object" || first === null || second === null) return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const firstKeys = Object.keys(first);
  if (firstKeys.length !== Object.keys(second).length) return false;
  return firstKeys.every(
    (key) => Object.hasOwn(second, key) && sameData((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]),
  );
}

/**
 * One item of a three-way merge. A side that changed the item since `base`
 * wins over a side that left it alone, also when the change is a deletion.
 * When both changed it, this window's version wins and `clash` is set.
 */
function mergeItem<T>(base: T | undefined, mine: T | undefined, theirs: T | undefined): { value: T | undefined; clash: boolean } {
  if (sameData(mine, base)) return { value: theirs, clash: false };
  if (sameData(theirs, base) || sameData(mine, theirs)) return { value: mine, clash: false };
  // A deletion never beats a change: the changed item is the one somebody is working on.
  if (mine === undefined) return { value: theirs, clash: false };
  if (theirs === undefined) return { value: mine, clash: false };
  return { value: mine, clash: true };
}

/** A panel id this window used that the merge replaced, because the stored document uses it for another panel. */
export interface PanelRename {
  readonly from: string;
  readonly to: string;
}

export interface WorkspaceMerge {
  /** The stored document with this window's work merged in, at the stored revision: save it against that revision. */
  readonly document: WorkspaceDocument;
  /** Layouts both windows changed. This window's version was kept and the other window's change to them is lost. */
  readonly overridden: readonly string[];
  /**
   * Panels of this window that got a new id. The window's layouts in the
   * merged document already use it; the window moves its live instance to it.
   */
  readonly renamedPanels: readonly PanelRename[];
}

const MAX_ID_LENGTH = 64;

/** `panel-1-2`, `panel-1-3`…: the first id no document of the merge uses. */
function freeId(panelId: string, taken: ReadonlySet<string>): string {
  for (let suffix = 2; ; suffix += 1) {
    const tail = "-" + suffix;
    const candidate = panelId.slice(0, MAX_ID_LENGTH - tail.length) + tail;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The tree with the tabs renamed; a tree without such tabs is returned as is. */
function renameTabs(node: LayoutNode, renames: ReadonlyMap<string, string>): LayoutNode {
  if (node.kind === "split") {
    const children = node.children.map((child) => renameTabs(child, renames));
    return children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
  }
  if (!node.tabs.some((tab) => renames.has(tab))) return node;
  const rename = (panelId: string): string => renames.get(panelId) ?? panelId;
  return { ...node, tabs: node.tabs.map(rename), activeTab: node.activeTab === null ? null : rename(node.activeTab) };
}

/**
 * Merges a refused save into the stored document. `base` is the document
 * both windows started from, `mine` this window's document, `theirs` the
 * document the conflict returned. Changes to different layouts are all kept;
 * a layout the other window created or changed is never lost; this window
 * stays on its own open layout. `livePanelIds` are the panels with an open
 * instance in this window, under this window's ids: their references stay.
 *
 * A panel id means one reference. When the two windows gave one id to
 * different references, the stored document keeps the id and this window's
 * panel gets a new one, in its layouts too, so no tile changes what it shows.
 */
export function mergeDocuments(
  base: WorkspaceDocument,
  mine: WorkspaceDocument,
  theirs: WorkspaceDocument,
  livePanelIds: ReadonlySet<string>,
): WorkspaceMerge {
  const find = (document: WorkspaceDocument, layoutId: string): NamedLayout | undefined =>
    document.layouts.find((layout) => layout.id === layoutId);
  const entry = (document: WorkspaceDocument, panelId: string): WorkspacePanel | undefined =>
    Object.hasOwn(document.panels, panelId) ? document.panels[panelId] : undefined;

  const chosen: NamedLayout[] = [];
  const overridden: string[] = [];
  const order = [...theirs.layouts, ...mine.layouts.filter((layout) => find(theirs, layout.id) === undefined)];
  for (const { id } of order) {
    const merged = mergeItem(find(base, id), find(mine, id), find(theirs, id));
    if (merged.value !== undefined) chosen.push(merged.value);
    if (merged.clash) overridden.push(id);
  }
  // Each window deleted every layout the other one kept: this window keeps what it has open.
  if (chosen.length === 0) chosen.push(find(mine, mine.activeLayoutId) ?? mine.layouts[0]);

  // Ids the two windows use for different references. A layout taken from this window means this window's reference.
  const clashing = Object.keys(mine.panels).filter((panelId) => {
    const other = entry(theirs, panelId);
    return other !== undefined && panelRefKey(other.ref) !== panelRefKey(mine.panels[panelId].ref);
  });
  const isMine = (layout: NamedLayout): boolean => find(mine, layout.id) === layout && find(theirs, layout.id) !== layout;
  const placedByMine = new Set(chosen.filter(isMine).flatMap(placedPanelIds));
  const taken = new Set([...Object.keys(base.panels), ...Object.keys(mine.panels), ...Object.keys(theirs.panels)]);
  const renames = new Map<string, string>();
  for (const panelId of clashing) {
    if (!placedByMine.has(panelId) && !livePanelIds.has(panelId)) continue;
    const renamed = freeId(panelId, taken);
    taken.add(renamed);
    renames.set(panelId, renamed);
  }
  const layouts = chosen.map((layout) => {
    if (!isMine(layout)) return layout;
    const root = renameTabs(layout.workspace.root, renames);
    return root === layout.workspace.root ? layout : { ...layout, workspace: { ...layout.workspace, root } };
  });

  const placed = new Set(layouts.flatMap(placedPanelIds));
  const panels: Record<string, WorkspacePanel> = {};
  const panelIds = [...Object.keys(theirs.panels), ...Object.keys(mine.panels).filter((panelId) => !Object.hasOwn(theirs.panels, panelId))];
  for (const panelId of panelIds) {
    if (clashing.includes(panelId)) {
      // The stored document owns a clashing id, whatever this window did to its own panel of that name.
      panels[panelId] = theirs.panels[panelId];
      continue;
    }
    const merged = mergeItem(entry(base, panelId), entry(mine, panelId), entry(theirs, panelId)).value;
    const needed = placed.has(panelId) || livePanelIds.has(panelId);
    const panel = merged ?? (needed ? (entry(theirs, panelId) ?? entry(mine, panelId)) : undefined);
    if (panel !== undefined) panels[panelId] = panel;
  }
  for (const [from, to] of renames) panels[to] = mine.panels[from];

  const stays = layouts.some((layout) => layout.id === mine.activeLayoutId);
  const theirsStays = layouts.some((layout) => layout.id === theirs.activeLayoutId);
  const activeLayoutId = stays ? mine.activeLayoutId : theirsStays ? theirs.activeLayoutId : layouts[0].id;
  return {
    document: { ...theirs, panels, layouts, activeLayoutId },
    overridden,
    renamedPanels: [...renames].map(([from, to]) => ({ from, to })),
  };
}

/** What Home shows on entry and whether the workspace may be saved. */
export interface WorkspaceEntry {
  /**
   * `first-entry`: nothing was stored. `restored`: the stored document.
   * `newer-version` and `corrupt`: storage holds a document this code must
   * not replace, so a fresh workspace is shown and `canSave` is false.
   */
  readonly origin: "first-entry" | "restored" | "newer-version" | "corrupt";
  readonly canSave: boolean;
  readonly document: WorkspaceDocument;
  /** The layout to show: the last active one, or the single content-picker tile. */
  readonly layout: NamedLayout;
  /** Damaged parts the reader left out of a restored document. */
  readonly dropped: readonly DroppedPart[];
}

/**
 * The entry rule of Home. A workspace nobody arranged yet gets one layout
 * with one full-size tile that offers to choose its content, under the id
 * and name the caller supplies. A stored workspace opens its last active
 * layout.
 */
export function enterWorkspace(read: WorkspaceReadResult, first: { readonly layoutId: string; readonly name: string }): WorkspaceEntry {
  if (read.status === "ok") {
    const layout = read.document.layouts.find((candidate) => candidate.id === read.document.activeLayoutId) ?? read.document.layouts[0];
    return { origin: "restored", canSave: true, document: read.document, layout, dropped: read.dropped };
  }
  const document = initialDocument(first.layoutId, first.name);
  const origin = read.status === "empty" ? "first-entry" : read.status === "newer" ? "newer-version" : "corrupt";
  return { origin, canSave: read.status === "empty", document, layout: document.layouts[0], dropped: [] };
}
