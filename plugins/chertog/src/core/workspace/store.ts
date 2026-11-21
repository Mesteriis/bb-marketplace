// Where the workspace document is kept, and the rule for two windows that
// save the same workspace: a save names the revision it was made from, a
// stale save is refused with the stored document, and the refused window
// merges its work into that document and saves again.
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

export interface WorkspaceMerge {
  /** The stored document with this window's work merged in, at the stored revision: save it against that revision. */
  readonly document: WorkspaceDocument;
  /** Layouts both windows changed. This window's version was kept and the other window's change to them is lost. */
  readonly overridden: readonly string[];
}

/**
 * Merges a refused save into the stored document. `base` is the document
 * both windows started from, `mine` this window's document, `theirs` the
 * document the conflict returned. Changes to different layouts are all kept;
 * a layout the other window created or changed is never lost; this window
 * stays on its own open layout. `livePanelIds` are the panels with an open
 * instance in this window: their references stay.
 */
export function mergeDocuments(
  base: WorkspaceDocument,
  mine: WorkspaceDocument,
  theirs: WorkspaceDocument,
  livePanelIds: ReadonlySet<string>,
): WorkspaceMerge {
  const find = (document: WorkspaceDocument, layoutId: string): NamedLayout | undefined =>
    document.layouts.find((layout) => layout.id === layoutId);

  const layouts: NamedLayout[] = [];
  const overridden: string[] = [];
  const order = [...theirs.layouts, ...mine.layouts.filter((layout) => find(theirs, layout.id) === undefined)];
  for (const { id } of order) {
    const merged = mergeItem(find(base, id), find(mine, id), find(theirs, id));
    if (merged.value !== undefined) layouts.push(merged.value);
    if (merged.clash) overridden.push(id);
  }
  // Each window deleted every layout the other one kept: this window keeps what it has open.
  if (layouts.length === 0) layouts.push(find(mine, mine.activeLayoutId) ?? mine.layouts[0]);

  const placed = new Set(layouts.flatMap(placedPanelIds));
  const panels: Record<string, WorkspacePanel> = {};
  const panelIds = [...Object.keys(theirs.panels), ...Object.keys(mine.panels).filter((panelId) => !Object.hasOwn(theirs.panels, panelId))];
  const entry = (document: WorkspaceDocument, panelId: string): WorkspacePanel | undefined =>
    Object.hasOwn(document.panels, panelId) ? document.panels[panelId] : undefined;
  for (const panelId of panelIds) {
    const merged = mergeItem(entry(base, panelId), entry(mine, panelId), entry(theirs, panelId)).value;
    const needed = placed.has(panelId) || livePanelIds.has(panelId);
    const panel = merged ?? (needed ? (entry(theirs, panelId) ?? entry(mine, panelId)) : undefined);
    if (panel !== undefined) panels[panelId] = panel;
  }

  const stays = layouts.some((layout) => layout.id === mine.activeLayoutId);
  const theirsStays = layouts.some((layout) => layout.id === theirs.activeLayoutId);
  const activeLayoutId = stays ? mine.activeLayoutId : theirsStays ? theirs.activeLayoutId : layouts[0].id;
  return { document: { ...theirs, panels, layouts, activeLayoutId }, overridden };
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
