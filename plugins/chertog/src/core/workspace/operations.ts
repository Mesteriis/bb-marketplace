// Operations on the workspace document. Each returns a new document, or the
// very same document when there is nothing to change, or the reason it was
// refused. None of them opens, closes or ends a panel: they change what is
// stored about names and places.
import type { LayoutOperation, WorkspaceState } from "../layout/index.ts";
import { addTab, applyOperation, closeTab, createWorkspace, findGroup, findGroupOfPanel } from "../layout/index.ts";
import { replaceGroup } from "../layout/tree.ts";
import { acceptsChoice } from "../panels/choose.ts";
import { panelRefKey } from "../panels/index.ts";
import type { PanelRef } from "../panels/index.ts";
import type { NamedLayout, WorkspaceDocument, WorkspacePanel } from "./document.ts";
import { activeLayout, idSchema, layoutNameSchema, placedPanelIds, workspacePanelSchema, workspaceStateSchema } from "./document.ts";

export type WorkspaceChangeRefusal =
  | "invalid-id"
  | "invalid-name"
  | "invalid-panel"
  | "invalid-layout"
  | "layout-exists"
  | "unknown-layout"
  | "last-layout"
  | "unknown-group"
  | "unknown-panel"
  | "panel-conflict"
  | "already-placed"
  | "not-placed";

export type WorkspaceChange =
  | { readonly ok: true; readonly document: WorkspaceDocument }
  | { readonly ok: false; readonly reason: WorkspaceChangeRefusal };

/** A panel of the document together with its id. */
export interface ListedPanel extends WorkspacePanel {
  readonly panelId: string;
}

/**
 * A preset: a named layout with the references of the panels it places. It is
 * data only. Adding it to a document opens nothing; a panel is opened when
 * its layout is shown.
 */
export interface LayoutTemplate {
  readonly name: string;
  readonly panels: Readonly<Record<string, WorkspacePanel>>;
  readonly workspace: WorkspaceState;
}

function applied(document: WorkspaceDocument): WorkspaceChange {
  return { ok: true, document };
}

function refused(reason: WorkspaceChangeRefusal): WorkspaceChange {
  return { ok: false, reason };
}

/** The name as it is stored, or `null` when it cannot be a name. */
function cleanName(name: string): string | null {
  const parsed = layoutNameSchema.safeParse(name.trim());
  return parsed.success ? parsed.data : null;
}

/** The panel as it is stored, or `null` when the schema refuses it. */
function cleanPanel(panel: WorkspacePanel): WorkspacePanel | null {
  const parsed = workspacePanelSchema.safeParse(panel);
  return parsed.success ? parsed.data : null;
}

function isId(id: string): boolean {
  return idSchema.safeParse(id).success;
}

function hasLayout(document: WorkspaceDocument, layoutId: string): boolean {
  return document.layouts.some((layout) => layout.id === layoutId);
}

function hasPanel(panels: Readonly<Record<string, WorkspacePanel>>, panelId: string): boolean {
  return Object.hasOwn(panels, panelId);
}

function replaceLayout(document: WorkspaceDocument, replaced: NamedLayout): WorkspaceDocument {
  return { ...document, layouts: document.layouts.map((layout) => (layout.id === replaced.id ? replaced : layout)) };
}

/**
 * The document without the references nothing needs any more: a reference
 * stays while a layout places its panel or a live instance shows it.
 * `livePanelIds` are the panels with an open instance, in any window.
 */
export function dropUnusedPanels(document: WorkspaceDocument, livePanelIds: ReadonlySet<string>): WorkspaceDocument {
  const placed = new Set(document.layouts.flatMap(placedPanelIds));
  const kept = Object.entries(document.panels).filter(([panelId]) => placed.has(panelId) || livePanelIds.has(panelId));
  if (kept.length === Object.keys(document.panels).length) return document;
  return { ...document, panels: Object.fromEntries(kept) };
}

/** Adds an empty layout, one content-picker tile, after the others and opens it. */
export function createLayout(document: WorkspaceDocument, layoutId: string, name: string): WorkspaceChange {
  if (!isId(layoutId)) return refused("invalid-id");
  if (hasLayout(document, layoutId)) return refused("layout-exists");
  const cleaned = cleanName(name);
  if (cleaned === null) return refused("invalid-name");
  const created: NamedLayout = { id: layoutId, name: cleaned, workspace: createWorkspace() };
  return applied({ ...document, layouts: [...document.layouts, created], activeLayoutId: layoutId });
}

export function renameLayout(document: WorkspaceDocument, layoutId: string, name: string): WorkspaceChange {
  const layout = document.layouts.find((candidate) => candidate.id === layoutId);
  if (layout === undefined) return refused("unknown-layout");
  const cleaned = cleanName(name);
  if (cleaned === null) return refused("invalid-name");
  return applied(cleaned === layout.name ? document : replaceLayout(document, { ...layout, name: cleaned }));
}

/** Copies a layout, places included, right after its source and opens the copy. The panels are shared, not copied. */
export function duplicateLayout(document: WorkspaceDocument, sourceLayoutId: string, layoutId: string, name: string): WorkspaceChange {
  const index = document.layouts.findIndex((layout) => layout.id === sourceLayoutId);
  if (index < 0) return refused("unknown-layout");
  if (!isId(layoutId)) return refused("invalid-id");
  if (hasLayout(document, layoutId)) return refused("layout-exists");
  const cleaned = cleanName(name);
  if (cleaned === null) return refused("invalid-name");
  const layouts = [...document.layouts];
  layouts.splice(index + 1, 0, { id: layoutId, name: cleaned, workspace: document.layouts[index].workspace });
  return applied({ ...document, layouts, activeLayoutId: layoutId });
}

/**
 * Deletes a layout; the last one stays. Deleting the open layout opens the
 * one before it, else the one after. References no other layout and no live
 * instance uses go with it.
 */
export function deleteLayout(document: WorkspaceDocument, layoutId: string, livePanelIds: ReadonlySet<string>): WorkspaceChange {
  const index = document.layouts.findIndex((layout) => layout.id === layoutId);
  if (index < 0) return refused("unknown-layout");
  if (document.layouts.length === 1) return refused("last-layout");
  const layouts = document.layouts.filter((layout) => layout.id !== layoutId);
  const activeLayoutId = document.activeLayoutId === layoutId ? layouts[Math.max(index - 1, 0)].id : document.activeLayoutId;
  return applied(dropUnusedPanels({ ...document, layouts, activeLayoutId }, livePanelIds));
}

export function switchLayout(document: WorkspaceDocument, layoutId: string): WorkspaceChange {
  if (!hasLayout(document, layoutId)) return refused("unknown-layout");
  return applied(document.activeLayoutId === layoutId ? document : { ...document, activeLayoutId: layoutId });
}

/**
 * Changes the open layout with a function of the layout core: a split, a
 * resize, a focus move, maximize. The result may place only panels the
 * document has a reference for and must stay a valid tree.
 */
export function changeActiveLayout(document: WorkspaceDocument, change: (workspace: WorkspaceState) => WorkspaceState): WorkspaceChange {
  const layout = activeLayout(document);
  const workspace = change(layout.workspace);
  if (workspace === layout.workspace) return applied(document);
  const changed: NamedLayout = { ...layout, workspace };
  if (placedPanelIds(changed).some((panelId) => !hasPanel(document.panels, panelId))) return refused("unknown-panel");
  if (!workspaceStateSchema.safeParse(workspace).success) return refused("invalid-layout");
  return applied(replaceLayout(document, changed));
}

/** Performs the placement change a drop resolved to, in the open layout. */
export function applyLayoutOperation(document: WorkspaceDocument, operation: LayoutOperation): WorkspaceChange {
  return changeActiveLayout(document, (workspace) => applyOperation(workspace, operation));
}

/** The id under which the document keeps this reference, whatever the order of its parameters. */
export function panelIdOfRef(document: WorkspaceDocument, ref: PanelRef): string | undefined {
  const key = panelRefKey(ref);
  return Object.keys(document.panels).find((panelId) => panelRefKey(document.panels[panelId].ref) === key);
}

/**
 * Makes a panel known to the document without placing it. The reference must
 * pass `panelRefSchema`, so credentials, correspondence and live handles are
 * refused here. An id that already names the same reference keeps its stored
 * entry; an id that names another reference is a conflict.
 */
export function registerPanel(document: WorkspaceDocument, panelId: string, panel: WorkspacePanel): WorkspaceChange {
  if (!isId(panelId)) return refused("invalid-id");
  const cleaned = cleanPanel(panel);
  if (cleaned === null) return refused("invalid-panel");
  if (hasPanel(document.panels, panelId)) {
    return panelRefKey(document.panels[panelId].ref) === panelRefKey(cleaned.ref) ? applied(document) : refused("panel-conflict");
  }
  return applied({ ...document, panels: { ...document.panels, [panelId]: cleaned } });
}

/**
 * Adds a panel to a group of the open layout as its last tab, active and
 * focused. A panel the document already knows needs no `panel`; a new one
 * brings its reference.
 */
export function addPanelToGroup(document: WorkspaceDocument, groupId: string, panelId: string, panel?: WorkspacePanel): WorkspaceChange {
  let known = document;
  if (panel !== undefined) {
    const registered = registerPanel(document, panelId, panel);
    if (!registered.ok) return registered;
    known = registered.document;
  } else if (!isId(panelId)) {
    return refused("invalid-id");
  } else if (!hasPanel(document.panels, panelId)) {
    return refused("unknown-panel");
  }
  const layout = activeLayout(known);
  if (findGroup(layout.workspace.root, groupId) === undefined) return refused("unknown-group");
  if (placedPanelIds(layout).includes(panelId)) return refused("already-placed");
  return changeActiveLayout(known, (workspace) => addTab(workspace, groupId, panelId));
}

/**
 * Takes a panel out of the open layout. Only the placement changes: nothing
 * is closed. The reference stays while another layout places the panel or a
 * live instance shows it, so the panel can be found among the hidden ones.
 */
export function removePanelFromLayout(document: WorkspaceDocument, panelId: string, livePanelIds: ReadonlySet<string>): WorkspaceChange {
  if (!placedPanelIds(activeLayout(document)).includes(panelId)) return refused("not-placed");
  const removed = changeActiveLayout(document, (workspace) => closeTab(workspace, panelId));
  return removed.ok ? applied(dropUnusedPanels(removed.document, livePanelIds)) : removed;
}

/** The panels the document keeps that the open layout does not place, in the order they were added. */
export function hiddenPanels(document: WorkspaceDocument): ListedPanel[] {
  const placed = new Set(placedPanelIds(activeLayout(document)));
  return Object.entries(document.panels)
    .filter(([panelId]) => !placed.has(panelId))
    .map(([panelId, panel]) => ({ panelId, ref: panel.ref }));
}

/**
 * Adds a preset as a new layout after the others, with the references of its
 * panels, and leaves the open layout open. A panel id the document already
 * uses must name the same reference; its stored entry is kept.
 */
export function addLayoutFromTemplate(document: WorkspaceDocument, layoutId: string, template: LayoutTemplate): WorkspaceChange {
  if (!isId(layoutId)) return refused("invalid-id");
  if (hasLayout(document, layoutId)) return refused("layout-exists");
  const name = cleanName(template.name);
  if (name === null) return refused("invalid-name");
  const workspace = workspaceStateSchema.safeParse(template.workspace);
  if (!workspace.success) return refused("invalid-layout");
  const layout: NamedLayout = { id: layoutId, name, workspace: workspace.data };
  if (placedPanelIds(layout).some((panelId) => !hasPanel(template.panels, panelId))) return refused("unknown-panel");
  let known = document;
  for (const panelId of placedPanelIds(layout)) {
    const registered = registerPanel(known, panelId, template.panels[panelId]);
    if (!registered.ok) return registered;
    known = registered.document;
  }
  return applied({ ...known, layouts: [...known.layouts, layout] });
}


/** Replace one chooser tab without changing focus, the split tree or any other layout. */
export function replaceChoosePanel(
  document: WorkspaceDocument, chooserId: string, selectedId: string, ref: PanelRef, livePanelIds: ReadonlySet<string>,
): WorkspaceChange {
  const layout = activeLayout(document);
  const group = findGroupOfPanel(layout.workspace.root, chooserId);
  if (!group) return refused("not-placed");
  if (!acceptsChoice(document.panels[chooserId].ref, ref)) return refused("invalid-panel");
  if (placedPanelIds(layout).includes(selectedId)) return refused("already-placed");
  const known = registerPanel(document, selectedId, { ref });
  if (!known.ok) return known;
  const root = replaceGroup(layout.workspace.root, {
    ...group,
    tabs: group.tabs.map(id => id === chooserId ? selectedId : id),
    activeTab: group.activeTab === chooserId ? selectedId : group.activeTab,
  });
  const result = replaceLayout(known.document, { ...layout, workspace: { ...layout.workspace, root } });
  if (livePanelIds.has(chooserId) || result.layouts.some(other => placedPanelIds(other).includes(chooserId))) return applied(result);
  const panels = { ...result.panels };
  delete panels[chooserId];
  return applied({ ...result, panels });
}
