// One window's workspace session: the document controller, the registry of
// live panels and the sources of panel content, kept for the life of the
// window. The session maps the panels of the document to live instances and
// keeps three actions apart: removing a panel from the layout hides its
// instance, closing releases it, and ending a session is asked for by name.
import {
  activateTab,
  addTab,
  applyOperation,
  closeTab,
  findGroup,
  findGroupOfPanel,
  listGroups,
  splitGroup,
  type WorkspaceState,
} from "../../../core/layout/index.ts";
import { applyPreset } from "../../../core/workspace/presets.ts";
import { replaceChoosePanel } from "../../../core/workspace/operations.ts";
import { acceptsChoice, CHOOSE_PROVIDER } from "../../../core/panels/choose.ts";
import { panelRefKey, PanelRegistry, type Clock, type Diagnostics, type PanelInstance, type PanelRef } from "../../../core/panels/index.ts";
import {
  activeLayout,
  addPanelToGroup,
  applyLayoutOperation,
  changeActiveLayout,
  deleteLayout,
  duplicateLayout,
  panelIdOfRef,
  placeInBlock,
  placedPanelIds,
  registerPanel,
  removePanelFromLayout,
  renameLayout,
  switchLayout,
  type IdRename,
  type ParentOf,
  type WorkspaceChange,
  type WorkspaceChangeRefusal,
  type WorkspaceDocument,
} from "../../../core/workspace/index.ts";
import type { ContentChoice, ContentSection, HiddenPanelEntry } from "../../../ui/chrome/index.ts";
import type { PanelLabel, TileSurfaceChange } from "../../../ui/tiles/index.ts";
import { Listeners, type ContentSource, type PanelStateText } from "./content-sources.ts";
import { appStrings } from "./strings.ts";
import { THREAD_PROVIDER, threadRef, type ThreadDirectory } from "./thread-source.ts";
import { refOfPanel, WorkspaceController, type WorkspaceRpcPort } from "./workspace-controller.ts";

/** How many tiles a layout may have; BB's own split has the same limit. */
export const TILE_LIMIT = 8;

/** The layout a workspace starts with. One id for every window, so two first entries merge into one layout. */
export const FIRST_LAYOUT = { layoutId: "layout-main", name: appStrings.firstLayoutName } as const;

export interface WorkspaceSessionOptions {
  readonly rpc: WorkspaceRpcPort;
  readonly sources: readonly ContentSource[];
  /** A new id with the given prefix, unique in this workspace: `panel-…`, `layout-…`, `view-…`. */
  newId(prefix: "panel" | "layout" | "view"): string;
  /** The threads BB lists; where a subthread learns its parent. Without it no thread has a parent. */
  readonly threads?: ThreadDirectory;
  readonly clock?: Clock;
  readonly diagnostics: Diagnostics;
}

/** Where picked content goes: a new tile beside the focused one, or a tab of a given tile. */
export type ContentDestination = { readonly kind: "new-tile" } | { readonly kind: "group"; readonly groupId: string };

export type CloseOutcome =
  | "closed"
  | "kept"
  /** Nothing was closed: this is the last view and closing ends the session. */
  | "needs-confirmation";

/** What a tile shows in place of live content. */
export interface PanelView {
  readonly instance: PanelInstance;
  /** The reference as the document keeps it; the instance withholds its parameters until the provider checked them. */
  readonly ref: PanelRef;
  readonly source: ContentSource | undefined;
  readonly title: string;
  readonly stateText: PanelStateText | null;
}

function applied(document: WorkspaceDocument): WorkspaceChange {
  return { ok: true, document };
}

/** Allocator progress alone is not a change to the user's arrangement. */
function samePlacement(a: WorkspaceState, b: WorkspaceState): boolean {
  if (a.focusedGroupId !== b.focusedGroupId || a.maximizedGroupId !== b.maximizedGroupId) return false;
  return a.root === b.root || JSON.stringify(a.root) === JSON.stringify(b.root);
}

export class WorkspaceSession {
  readonly registry: PanelRegistry;
  readonly controller: WorkspaceController;
  readonly sources: readonly ContentSource[];
  private readonly newId: WorkspaceSessionOptions["newId"];
  private readonly threads: ThreadDirectory | undefined;
  /** The live instance of a panel of the document, by panel id. */
  private readonly instances = new Map<string, string>();
  /** Panels whose reference the provider refused to open. */
  private readonly refused = new Set<string>();
  private readonly listeners = new Listeners();
  readonly reservations = new Map<string, {
    panelId: string; source: ContentSource; groupId: string; layoutId: string; split: boolean;
  }>();
  private placement: { base: WorkspaceState; shown: WorkspaceState } | null = null;
  choiceError: string | null = null;

  dismissChoiceError(): void { this.choiceError = null; this.touch(); }

  private version = 0;
  private syncing = false;

  constructor(options: WorkspaceSessionOptions) {
    this.newId = options.newId;
    this.threads = options.threads;
    this.sources = options.sources;
    this.registry = new PanelRegistry({
      clock: options.clock ?? { now: () => Date.now() },
      ids: { nextId: () => options.newId("view") },
      diagnostics: options.diagnostics,
    });
    this.controller = new WorkspaceController({
      rpc: options.rpc,
      first: FIRST_LAYOUT,
      livePanelIds: () => this.livePanelIds(),
      onPanelsRenamed: (renames) => this.renamePanels(renames),
    });
    for (const source of options.sources) {
      this.registry.registerProvider(source.provider);
      source.connect?.(this.registry);
      source.subscribe(() => this.touch());
    }
    this.registry.subscribe(() => this.touch());
    this.controller.subscribe(() => {
      this.sync();
      this.touch();
    });
  }

  /** Changes with everything the views read: the document, the registry and the sources. */
  getVersion = (): number => this.version;

  subscribe = this.listeners.subscribe;

  // ----- what the views read -----

  document(): WorkspaceDocument | null {
    return this.controller.getSnapshot().document;
  }

  sourceOf(providerType: string): ContentSource | undefined {
    return this.sources.find((source) => source.provider.type === providerType);
  }

  instanceOfPanel(panelId: string): PanelInstance | null {
    const instanceId = this.instances.get(panelId);
    return instanceId === undefined ? null : this.registry.get(instanceId);
  }

  panelOfInstance(instanceId: string): string | null {
    for (const [panelId, mapped] of this.instances) {
      if (mapped === instanceId) return panelId;
    }
    return null;
  }

  /** The panels of the document that have a live instance in this window. */
  livePanelIds(): ReadonlySet<string> {
    const live = new Set<string>();
    for (const [panelId, instanceId] of this.instances) {
      if (this.registry.get(instanceId) !== null) live.add(panelId);
    }
    return live;
  }

  /**
   * The label of a panel: the provider's own title, asked for by the stored
   * reference each time, or a neutral caption by the provider's kind until
   * the provider knows the panel.
   */
  labelOf(panelId: string): PanelLabel {
    const document = this.document();
    const ref = document === null ? null : refOfPanel(document, panelId);
    const source = ref === null ? undefined : this.sourceOf(ref.provider);
    const known = ref === null || source === undefined ? null : source.label(ref);
    const label: PanelLabel = {
      ...(known ?? { title: source?.neutralLabel ?? appStrings.panelNeutral }),
      ...handoffLabel(ref?.provider),
    };
    if (this.refused.has(panelId)) return { ...label, status: { tone: "error", label: appStrings.openFailed } };
    const state = this.instanceOfPanel(panelId)?.state;
    if (state === undefined || state === "live" || state === "entry" || state === "loading") return label;
    return { ...label, status: { tone: "error", label: appStrings.hiddenState[state] } };
  }

  labels(): Record<string, PanelLabel> {
    const document = this.document();
    const labels = document === null ? {} : Object.fromEntries(Object.keys(document.panels).map((panelId) => [panelId, this.labelOf(panelId)]));
    for (const r of this.reservations.values()) labels[r.panelId] = { title: r.source.neutralLabel, ...handoffLabel(r.source.provider.type) };
    return labels;
  }

  /** What the content of an instance needs to draw itself, or `null` once the instance is closed. */
  viewOf(instanceId: string): PanelView | null {
    const instance = this.registry.get(instanceId);
    const panelId = this.panelOfInstance(instanceId);
    const document = this.document();
    const ref = panelId === null || document === null ? null : refOfPanel(document, panelId);
    if (instance === null || panelId === null || ref === null) return null;
    const source = this.sourceOf(ref.provider);
    return {
      instance,
      ref,
      source,
      title: this.labelOf(panelId).title,
      stateText: source?.stateText(instance.state, ref, instanceId) ?? null,
    };
  }

  /** The sections of the content picker. An item the open layout already places carries the panel to show instead. */
  contentSections(): ContentSection[] {
    const document = this.document();
    const placed = new Map<string, string>();
    if (document) {
      for (const id of placedPanelIds(activeLayout(document))) placed.set(panelRefKey(document.panels[id].ref), id);
    }
    return this.sources
      .filter((source) => source.offered())
      .map((source) => {
        const section = source.section();
        return {
          providerId: source.provider.type,
          title: source.sectionTitle,
          state: section.state,
          controls: source.controls?.(),
          items: section.items.map((item) => {
            const ref = source.stableRefOf(item.id);
            const panelId = ref === null ? undefined : placed.get(panelRefKey(ref));
            // The picker hands this value back unchanged; the panel says both which tile and which tab.
            return panelId !== undefined ? { ...item, openInTileId: panelId } : item;
          }),
        };
      });
  }

  /** Every instance the open layout does not place: hidden, and still held. */
  hiddenPanels(): HiddenPanelEntry[] {
    const document = this.document();
    if (document === null) return [];
    const placed = new Set(placedPanelIds(activeLayout(document)));
    return this.registry.list().flatMap((instance) => {
      const panelId = this.panelOfInstance(instance.instanceId);
      if (panelId === null || placed.has(panelId)) return [];
      const label = this.labelOf(panelId);
      const context = instance.state === "live" || instance.state === "entry" ? label.context : appStrings.hiddenState[instance.state];
      return [{ instanceId: instance.instanceId, title: label.title, ...(context === undefined ? {} : { context }) }];
    });
  }

  /** The instance shown in the focused tile of the open layout. */
  focusedInstance(): PanelInstance | null {
    const workspace = this.surfaceState();
    if (workspace === null) return null;
    const panelId = findGroup(workspace.root, workspace.focusedGroupId)?.activeTab ?? null;
    return panelId === null ? null : this.instanceOfPanel(panelId);
  }

  // ----- layout -----

  /** A change the tile surface asked for: a drop, or the state after a focus move, a resize, maximize or a removal. */
  applySurfaceChange(change: TileSurfaceChange): void {
    // A transient group cannot be written into the shared layout.
    if (this.reservations.size) {
      const base = this.document();
      const shown = this.surfaceState();
      if (!base || !shown) return;
      const next = change.kind === "operation" ? applyOperation(shown, change.operation) : change.state;
      this.commitSurface(activeLayout(base).workspace, next);
      return;
    }
    if (change.kind === "operation") {
      this.controller.change((document) => applyLayoutOperation(document, change.operation));
    } else {
      this.controller.change((document) => changeActiveLayout(document, () => change.state));
    }
  }

  private commitSurface(current: WorkspaceState, shown: WorkspaceState): void {
    const projected = this.withoutReservations(shown);
    // Removing a purely provisional last tile allocates a new empty picker
    // group. Keep the saved empty group and its id in that case.
    const staysEmpty = current.root.kind === "group" && current.root.tabs.length === 0 &&
      projected.root.kind === "group" && projected.root.tabs.length === 0;
    const changed = !staysEmpty && !samePlacement(current, projected);
    for (const [id, reservation] of this.reservations) {
      if (!findGroupOfPanel(shown.root, reservation.panelId)) this.releaseChoice(id);
    }
    this.placement = this.reservations.size ? { base: changed ? projected : current, shown } : null;
    if (changed) this.controller.change(document => changeActiveLayout(document, () => projected));
    this.touch();
  }

  changeLayout(change: (workspace: WorkspaceState) => WorkspaceState): void {
    const shown = this.surfaceState();
    if (shown) this.applySurfaceChange({ kind: "state", state: change(shown) });
  }

  switchLayout(layoutId: string): void {
    this.controller.change((document) => switchLayout(document, layoutId));
  }

  /** A new layout that starts as a copy of the open one and becomes the open one. */
  createLayoutFromCurrent(name: string): void {
    this.controller.change((document) => duplicateLayout(document, document.activeLayoutId, this.newId("layout"), name));
  }

  createFromPreset(presetId: string, name: string): void {
    const id = this.newId("layout");
    this.controller.change(document => {
      const result = applyPreset(document, id, presetId);
      return result.ok ? renameLayout(result.document, id, name) : result;
    });
  }

  replaceChoice(instanceId: string, choice: ContentChoice): void {
    const chooser = this.panelOfInstance(instanceId);
    const ref = this.sourceOf(choice.providerId)?.refOf(choice.itemId);
    this.controller.change((document, live) => {
      if (!chooser || !ref) return { ok: false, reason: "unknown-panel" };
      const retained = new Set(live);
      retained.delete(chooser);
      return replaceChoosePanel(document, chooser, this.newId("panel"), ref, retained);
    });
    if (chooser && !this.document()?.panels[chooser]) void this.registry.close(instanceId);
  }

  duplicateLayout(layoutId: string, name: string): void {
    this.controller.change((document) => duplicateLayout(document, layoutId, this.newId("layout"), name));
  }

  renameLayout(layoutId: string, name: string): void {
    this.controller.change((document) => renameLayout(document, layoutId, name));
  }

  deleteLayout(layoutId: string): void {
    this.controller.change((document, live) => deleteLayout(document, layoutId, live));
  }

  // ----- content -----

  /**
   * Places the chosen content in the open layout. Content the layout already
   * shows is brought to the front instead; content that is hidden and live
   * comes back as the same instance.
   */
  openContent(choice: Pick<ContentChoice, "providerId" | "itemId" | "placement">, destination: ContentDestination): WorkspaceChangeRefusal | null {
    const source = this.sourceOf(choice.providerId);
    if (source?.embed && choice.itemId === "choose")
      return this.chooseResource(source, destination, destination.kind === "new-tile" && choice.placement !== "tab");
    const ref = source?.refOf(choice.itemId) ?? null;
    if (ref === null) return "unknown-panel";
    return this.controller.change((document) => {
      const key = panelRefKey(ref);
      const placed = placedPanelIds(activeLayout(document)).find(id => panelRefKey(document.panels[id].ref) === key);
      const existing = placed ?? panelIdOfRef(document, ref);
      const panelId = existing ?? this.newId("panel");
      const workspace = activeLayout(document).workspace;
      if (findGroupOfPanel(workspace.root, panelId) !== undefined) {
        return changeActiveLayout(document, (current) => activateTab(current, panelId));
      }
      const known = existing === undefined ? registerPanel(document, panelId, { ref }) : applied(document);
      if (!known.ok) return known;
      if (destination.kind === "group") return addPanelToGroup(known.document, destination.groupId, panelId);
      if (choice.placement === "tab") return addPanelToGroup(known.document, workspace.focusedGroupId, panelId);
      return changeActiveLayout(known.document, (current) => splitGroup(current, current.focusedGroupId, "right", panelId));
    });
  }

  /**
   * The parent panel of a thread panel: the panel of the parent thread the
   * directory names, when the open layout places it. `undefined` otherwise.
   */
  parentOf: ParentOf = (panelId) => {
    const document = this.document();
    const ref = document?.panels[panelId]?.ref;
    if (document === null || ref === undefined || ref.provider !== THREAD_PROVIDER) return undefined;
    return this.placedParentOf(document, String(ref.params.threadId));
  };

  /**
   * Shows a BB thread as a tile of the open layout. A thread the layout
   * already places is focused; a subthread whose parent is placed joins the
   * parent's block; any other thread gets a tile right of the focused one.
   * `"not-shown"` only when the page is not shown; a change the core or the
   * tile limit refuses is `"refused"` and is reported like any other refusal.
   */
  openThread(threadId: string): "opened" | "focused" | "refused" | "not-shown" {
    if (this.surfaceState() === null) return "not-shown";
    const ref = threadRef(threadId);
    let outcome: "opened" | "focused" = "opened";
    let chooser: string | undefined;
    const refusal = this.controller.change((document, live) => {
      const workspace = activeLayout(document).workspace;
      const existing = panelIdOfRef(document, ref);
      if (existing !== undefined && findGroupOfPanel(workspace.root, existing) !== undefined) {
        outcome = "focused";
        return changeActiveLayout(document, (current) => activateTab(current, existing));
      }
      outcome = "opened";
      const panelId = existing ?? this.newId("panel");
      const placed = this.placeThread(document, live, threadId, panelId, existing !== undefined);
      if (!placed.ok) return placed;
      chooser = placed.chooser;
      return listGroups(activeLayout(placed.document).workspace.root).length > TILE_LIMIT ? { ok: false, reason: "invalid-layout" } : placed;
    });
    if (refusal !== null) return "refused";
    const instanceId = chooser === undefined ? null : this.instanceOfPanel(chooser)?.instanceId ?? null;
    if (chooser !== undefined && instanceId !== null && !this.document()?.panels[chooser]) void this.registry.close(instanceId);
    return outcome;
  }

  /** Places a thread that is not placed: in its parent's block, in the picker that waits in the focused tile, or in a tile of its own. */
  private placeThread(
    document: WorkspaceDocument, live: ReadonlySet<string>, threadId: string, panelId: string, known: boolean,
  ): WorkspaceChange & { chooser?: string } {
    const ref = threadRef(threadId);
    const parentPanelId = this.placedParentOf(document, threadId);
    if (parentPanelId !== undefined) return placeInBlock(document, parentPanelId, panelId, { ref }, this.parentOf);
    const workspace = activeLayout(document).workspace;
    const focused = findGroup(workspace.root, workspace.focusedGroupId);
    if (focused !== undefined && focused.tabs.length === 0) return addPanelToGroup(document, focused.id, panelId, { ref });
    const active = focused?.activeTab ?? null;
    if (active !== null && acceptsChoice(document.panels[active].ref, ref)) {
      const retained = new Set(live);
      retained.delete(active);
      return { ...replaceChoosePanel(document, active, panelId, ref, retained), chooser: active } as WorkspaceChange & { chooser?: string };
    }
    const registered = known ? applied(document) : registerPanel(document, panelId, { ref });
    if (!registered.ok) return registered;
    return changeActiveLayout(registered.document, (current) => splitGroup(current, current.focusedGroupId, "right", panelId));
  }

  /** The panel of the parent thread the directory names for a thread, when the open layout places it. */
  private placedParentOf(document: WorkspaceDocument, threadId: string): string | undefined {
    const parentThreadId = this.threads?.find(threadId)?.parentThreadId;
    if (parentThreadId === undefined) return undefined;
    const parentPanelId = panelIdOfRef(document, threadRef(parentThreadId));
    if (parentPanelId === undefined) return undefined;
    return findGroupOfPanel(activeLayout(document).workspace.root, parentPanelId) === undefined ? undefined : parentPanelId;
  }

  private withoutReservations(shown: WorkspaceState, keepId?: string): WorkspaceState {
    let state = shown;
    for (const [id, reservation] of this.reservations) {
      if (id !== keepId) state = closeTab(state, reservation.panelId);
    }
    return state;
  }

  private holdsPlacement(base: WorkspaceState): boolean {
    return this.placement !== null && (this.placement.base === base ||
      (this.placement.base.nextNodeId === base.nextNodeId && samePlacement(this.placement.base, base)));
  }

  surfaceState(): WorkspaceState | null {
    const document = this.document();
    if (!document) return null;
    const base = activeLayout(document).workspace;
    if (!this.reservations.size) return base;
    if (this.placement && this.holdsPlacement(base)) return this.placement.shown;
    let state = base;
    for (const r of this.reservations.values()) {
      if (r.layoutId === document.activeLayoutId)
        state = r.split ? splitGroup(state, r.groupId, "right", r.panelId) : addTab(state, r.groupId, r.panelId);
    }
    this.placement = { base, shown: state };
    return state;
  }

  private chooseResource(source: ContentSource, destination: ContentDestination, split: boolean): WorkspaceChangeRefusal | null {
    const doc = this.document();
    if (!doc || !source.embed) return "unknown-panel";
    const state = activeLayout(doc).workspace;
    const groupId = destination.kind === "group" ? destination.groupId : state.focusedGroupId;
    if (!findGroup(state.root, groupId)) return "unknown-group";
    if (split && listGroups(this.surfaceState()!.root).length >= TILE_LIMIT) return "invalid-layout";
    const id = this.registry.reserve(source.provider.type);
    if (id === null) return "unknown-panel";
    const panelId = this.newId("panel");
    const shown = this.surfaceState()!;
    this.reservations.set(id, { panelId, source, groupId, split, layoutId: doc.activeLayoutId });
    this.placement = { base: state, shown: split ? splitGroup(shown, groupId, "right", panelId) : addTab(shown, groupId, panelId) };
    this.choiceError = null;
    source.embed.choose(id, uuid => this.acceptChoice(id, uuid), reason => {
      if (reason) this.choiceError = source.neutralLabel + ". " + reason;
      this.cancelChoice(id);
    });
    this.touch();
    return null;
  }

  private cancelChoice(id: string): void {
    const r = this.reservations.get(id);
    if (!r) return;
    const doc = this.document();
    const shown = this.surfaceState();
    if (doc && shown && doc.activeLayoutId === r.layoutId) {
      this.commitSurface(activeLayout(doc).workspace, closeTab(shown, r.panelId));
      return;
    }
    this.releaseChoice(id);
    this.touch();
  }

  private releaseChoice(id: string): void {
    const r = this.reservations.get(id);
    if (!r) return;
    this.reservations.delete(id);
    this.registry.cancelReservation(id);
    void r.source.provider.release(id);
  }

  private acceptChoice(id: string, resourceRef: string): void {
    const r = this.reservations.get(id);
    const doc = this.document();
    if (!r || !doc) return;
    const state = activeLayout(doc).workspace;
    const ref = { provider: r.source.provider.type, params: { resourceRef } };
    if (doc.activeLayoutId !== r.layoutId || !findGroupOfPanel(this.surfaceState()!.root, r.panelId) ||
        (r.split && listGroups(state.root).length >= TILE_LIMIT) || !r.source.provider.paramsSchema.safeParse(ref.params).success) {
      this.cancelChoice(id);
      return;
    }
    const existing = panelIdOfRef(doc, ref);
    if (!r.source.provider.multipleViews && existing) {
      this.cancelChoice(id);
      if (findGroupOfPanel(state.root, existing)) this.focusPanel(existing);
      else this.controller.change(current => addPanelToGroup(current, r.groupId, existing));
      return;
    }
    const known = registerPanel(doc, r.panelId, { ref });
    const shown = this.surfaceState()!;
    const accepted = this.withoutReservations(shown, id);
    const placed = known.ok ? changeActiveLayout(known.document, () => accepted) : known;
    if (!placed.ok) { this.cancelChoice(id); return; }
    const opened = this.registry.acceptReservation(id, ref, () => {
      this.instances.set(r.panelId, id);
      this.reservations.delete(id);
      this.placement = this.reservations.size ? { base: accepted, shown } : null;
      this.controller.change(() => placed);
    });
    if (!opened.ok) this.cancelChoice(id);
  }

  /** Shows the tab of a panel the open layout places and focuses its tile. */
  focusPanel(panelId: string): void {
    this.changeLayout((workspace) => activateTab(workspace, panelId));
  }

  /** Brings a hidden instance back as a tab of the focused tile. */
  showHidden(instanceId: string): void {
    const panelId = this.panelOfInstance(instanceId);
    if (panelId === null) return;
    this.controller.change((document) => addPanelToGroup(document, activeLayout(document).workspace.focusedGroupId, panelId));
  }

  // ----- the three actions -----

  /** Removes the panel from the open layout. Its instance stays as live as it was and is listed among the hidden panels. */
  removeFromLayout(panelId: string): void {
    for (const [id, r] of this.reservations) if (r.panelId === panelId) { this.cancelChoice(id); return; }
    this.controller.change((document, live) => removePanelFromLayout(document, panelId, live));
  }

  /**
   * Closes the panel: releases its view once and takes it out of the open
   * layout. When the registry warns that this ends the session, nothing
   * happens until the user confirms.
   */
  async closePanel(panelId: string, options: { confirmEndsSession?: boolean } = {}): Promise<CloseOutcome> {
    for (const [id, r] of this.reservations) if (r.panelId === panelId) { this.cancelChoice(id); return "closed"; }
    const instanceId = this.instances.get(panelId);
    if (instanceId !== undefined) {
      const view = this.viewOf(instanceId);
      if (view?.source?.embed && view.instance.state !== "access-denied" && view.instance.state !== "session-ended") {
        const decision = await view.source.embed.close(instanceId);
        if (decision === "hide") this.removeFromLayout(panelId);
        if (decision !== "ended") return "kept";
      }
      const result = await this.registry.close(instanceId, options);
      if (result.status === "needs-confirmation") return "needs-confirmation";
      if (this.instances.get(panelId) === instanceId) this.instances.delete(panelId);
    }
    this.refused.delete(panelId);
    this.controller.change((document, live) => {
      const placed = placedPanelIds(activeLayout(document)).includes(panelId);
      return placed ? removePanelFromLayout(document, panelId, live) : applied(document);
    });
    return "closed";
  }

  closeInstance(instanceId: string, options: { confirmEndsSession?: boolean } = {}): Promise<CloseOutcome> {
    const panelId = this.panelOfInstance(instanceId);
    return panelId === null ? Promise.resolve("closed") : this.closePanel(panelId, options);
  }

  /** Ends the session of a live panel through its provider. Runs only on the user's explicit action. */
  endSession(instanceId: string): ReturnType<PanelRegistry["endSession"]> {
    return this.registry.endSession(instanceId);
  }

  /** Asks the provider again for a panel that is not live. One call per click of the user. */
  retry(instanceId: string): void {
    this.registry.retryOpen(instanceId);
  }

  // ----- keeping the registry in step with the document -----

  private touch(): void {
    this.version += 1;
    this.listeners.notify();
  }

  private renamePanels(renames: readonly IdRename[]): void {
    for (const { from, to } of renames) {
      const instanceId = this.instances.get(from);
      if (instanceId === undefined) continue;
      this.instances.delete(from);
      this.instances.set(to, instanceId);
    }
  }

  /**
   * After every change of the document: a panel is opened the first time its
   * tab is shown, and an instance is marked placed or hidden by whether the
   * open layout places its panel. Nothing is closed here.
   */
  private sync(): void {
    const document = this.document();
    if (document === null || this.syncing) return;
    this.syncing = true;
    try {
      for (const [panelId, instanceId] of this.instances) {
        if (this.registry.get(instanceId) === null) this.instances.delete(panelId);
      }
      const layout = activeLayout(document);
      for (const [id, r] of this.reservations) {
        if (layout.id !== r.layoutId || (!this.holdsPlacement(layout.workspace) && !findGroup(layout.workspace.root, r.groupId))) this.releaseChoice(id);
      }
      const placed = new Set(placedPanelIds(layout));
      for (const group of listGroups(layout.workspace.root)) {
        const panelId = group.activeTab;
        if (panelId === null || this.instances.has(panelId) || this.refused.has(panelId)) continue;
        const ref = refOfPanel(document, panelId);
        if (ref === null) continue;
        const source = this.sourceOf(ref.provider);
        const newView = ref.provider === CHOOSE_PROVIDER || Boolean(source?.embed && source.provider.multipleViews);
        const opened = this.registry.open(ref, { newView });
        // One reference is one instance: a second panel id for it would show the same view twice.
        if (!opened.ok) {
          this.refused.add(panelId);
          continue;
        }
        const previous = this.panelOfInstance(opened.instance.instanceId);
        if (previous !== null) {
          if (placed.has(previous)) {
            this.refused.add(panelId);
            continue;
          }
          // Presets may use a fresh panel id for the very same provider entry.
          this.instances.delete(previous);
        }
        this.instances.set(panelId, opened.instance.instanceId);
      }
      for (const [panelId, instanceId] of this.instances) {
        if (placed.has(panelId)) this.registry.returnToLayout(instanceId);
        else this.registry.removeFromLayout(instanceId);
      }
      for (const panelId of this.refused) {
        if (!Object.hasOwn(document.panels, panelId)) this.refused.delete(panelId);
      }
    } finally {
      this.syncing = false;
    }
  }
}

function handoffLabel(provider: string | undefined): Pick<PanelLabel, "handoffUnavailable"> {
  if (provider === "bb-thread") return {};
  return { handoffUnavailable: provider === "zoom-call"
    ? "Звонок нельзя перенести без потери связи."
    : "Провайдер не поддерживает безопасную передачу этой панели." };
}
