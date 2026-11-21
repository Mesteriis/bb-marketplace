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
 * One item of a three-way merge when at most one side changed it since
 * `base`, or both changed it the same way. The changed side wins, also when
 * its change is a deletion; a deletion never beats a change, because the
 * changed item is the one somebody is working on.
 */
function mergeItem<T>(base: T | undefined, mine: T | undefined, theirs: T | undefined): T | undefined {
  if (sameData(mine, base)) return theirs;
  if (sameData(theirs, base) || sameData(mine, theirs)) return mine;
  return mine ?? theirs;
}

/** Whether both windows have the item and each made it, or changed it, in its own way. */
function diverged<T>(base: T | undefined, mine: T | undefined, theirs: T | undefined): boolean {
  return mine !== undefined && theirs !== undefined && !sameData(mine, theirs) && !sameData(mine, base) && !sameData(theirs, base);
}

/** An id of this window that the merge replaced, because the stored document uses it for something else. */
export interface IdRename {
  readonly from: string;
  readonly to: string;
}

export interface WorkspaceMerge {
  /** The stored document with this window's work merged in, at the stored revision: save it against that revision. */
  readonly document: WorkspaceDocument;
  /**
   * Layouts both windows created under one id, or both changed. The stored
   * version keeps the id; this window's version is kept beside it under the
   * new id, with its name, and stays open in this window.
   */
  readonly renamedLayouts: readonly IdRename[];
  /**
   * Panels of this window that got a new id. The window's layouts in the
   * merged document already use it; the window moves its live instance to it.
   */
  readonly renamedPanels: readonly IdRename[];
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

/** The document with panel ids replaced, in the dictionary and in every tab. */
function renamePanels(document: WorkspaceDocument, renames: ReadonlyMap<string, string>): WorkspaceDocument {
  if (renames.size === 0) return document;
  const panels = Object.fromEntries(Object.entries(document.panels).map(([panelId, panel]) => [renames.get(panelId) ?? panelId, panel]));
  const layouts = document.layouts.map((layout) => {
    const root = renameTabs(layout.workspace.root, renames);
    return root === layout.workspace.root ? layout : { ...layout, workspace: { ...layout.workspace, root } };
  });
  return { ...document, panels, layouts };
}

/**
 * Merges a refused save into the stored document. `base` is the document
 * both windows started from, `mine` this window's document, `theirs` the
 * document the conflict returned. Nothing either window made is lost:
 * changes to different layouts are all kept, and a layout both windows
 * created or changed is kept in both versions. This window stays on its own
 * open layout. `livePanelIds` are the panels with an open instance in this
 * window, under this window's ids: their references stay.
 *
 * An id means one thing. When the two windows gave one panel id to different
 * references, this window's panel gets a new id before anything is compared,
 * so two trees that look alike but show different panels are not taken for
 * one. When they gave one layout id to different layouts, the stored layout
 * keeps the id and this window's layout gets a new one.
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

  // Panel ids first: a clashing id of this window is renamed wherever this window means its own reference by it.
  const takenPanelIds = new Set([...Object.keys(base.panels), ...Object.keys(mine.panels), ...Object.keys(theirs.panels)]);
  const mineRenames = new Map<string, string>();
  const baseRenames = new Map<string, string>();
  for (const panelId of Object.keys(mine.panels)) {
    const own = panelRefKey(mine.panels[panelId].ref);
    const stored = entry(theirs, panelId);
    if (stored === undefined || panelRefKey(stored.ref) === own) continue;
    const renamed = freeId(panelId, takenPanelIds);
    takenPanelIds.add(renamed);
    mineRenames.set(panelId, renamed);
    // The common ancestor meant the same reference as this window: it is renamed alike, so only real changes show.
    const before = entry(base, panelId);
    if (before !== undefined && panelRefKey(before.ref) === own) baseRenames.set(panelId, renamed);
  }
  const live = new Set([...livePanelIds].map((panelId) => mineRenames.get(panelId) ?? panelId));
  const before = renamePanels(base, baseRenames);
  const own = renamePanels(mine, mineRenames);

  const layouts: NamedLayout[] = [];
  const copies: NamedLayout[] = [];
  const layoutRenames = new Map<string, string>();
  const takenLayoutIds = new Set([...base.layouts, ...mine.layouts, ...theirs.layouts].map((layout) => layout.id));
  const order = [...theirs.layouts, ...own.layouts.filter((layout) => find(theirs, layout.id) === undefined)];
  for (const { id } of order) {
    const [ancestor, ours, stored] = [find(before, id), find(own, id), find(theirs, id)];
    if (ours !== undefined && stored !== undefined && diverged(ancestor, ours, stored)) {
      const renamed = freeId(id, takenLayoutIds);
      takenLayoutIds.add(renamed);
      layoutRenames.set(id, renamed);
      layouts.push(stored);
      copies.push({ ...ours, id: renamed });
      continue;
    }
    const merged = mergeItem(ancestor, ours, stored);
    if (merged !== undefined) layouts.push(merged);
  }
  layouts.push(...copies);
  // Each window deleted every layout the other one kept: this window keeps what it has open.
  if (layouts.length === 0) layouts.push(find(own, own.activeLayoutId) ?? own.layouts[0]);

  const placed = new Set(layouts.flatMap(placedPanelIds));
  const panels: Record<string, WorkspacePanel> = {};
  const panelIds = [...Object.keys(theirs.panels), ...Object.keys(own.panels).filter((panelId) => !Object.hasOwn(theirs.panels, panelId))];
  const renamedTo = new Set(mineRenames.values());
  for (const panelId of panelIds) {
    const needed = placed.has(panelId) || live.has(panelId);
    // A renamed panel is this window's alone: it stays only while a merged layout or a live instance uses it.
    const merged = renamedTo.has(panelId) ? undefined : mergeItem(entry(before, panelId), entry(own, panelId), entry(theirs, panelId));
    const panel = merged ?? (needed ? (entry(theirs, panelId) ?? entry(own, panelId)) : undefined);
    if (panel !== undefined) panels[panelId] = panel;
  }

  const open = layoutRenames.get(own.activeLayoutId) ?? own.activeLayoutId;
  const has = (layoutId: string): boolean => layouts.some((layout) => layout.id === layoutId);
  const activeLayoutId = has(open) ? open : has(theirs.activeLayoutId) ? theirs.activeLayoutId : layouts[0].id;
  return {
    document: { ...theirs, panels, layouts, activeLayoutId },
    renamedLayouts: [...layoutRenames].map(([from, to]) => ({ from, to })),
    renamedPanels: [...mineRenames].filter(([, to]) => Object.hasOwn(panels, to)).map(([from, to]) => ({ from, to })),
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
