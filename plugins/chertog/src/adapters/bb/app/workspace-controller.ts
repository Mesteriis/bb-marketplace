// The workspace of one window: the document it shows, and how it reaches the
// plugin's server. Every change goes through an operation of the core and is
// saved against the revision it was made from. Saves go one at a time and the
// last state always follows; a save another window beat is merged into that
// window's document and sent again; a save that failed stays in the window
// and is shown.
import type { PanelRef } from "../../../core/panels/index.ts";
import { loadWorkspaceOutputSchema, saveWorkspaceOutputSchema } from "../../../core/wire/index.ts";
import type {
  DroppedPart,
  IdRename,
  WorkspaceChange,
  WorkspaceChangeRefusal,
  WorkspaceDocument,
  WorkspaceEntry,
  WorkspaceReadResult,
  WorkspaceSaveResult,
} from "../../../core/workspace/index.ts";
import { dropUnusedPanels, enterWorkspace, mergeDocuments } from "../../../core/workspace/index.ts";

/** The two calls of the workspace RPC, as the controller uses them. */
export interface WorkspaceRpcPort {
  load(): Promise<WorkspaceReadResult>;
  save(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult>;
}

/** The part of the SDK's RPC client the port needs; `useRpc()` returns one. */
export interface WorkspaceRpcClient {
  call(method: "load_workspace", input: Record<string, never>): Promise<unknown>;
  call(method: "save_workspace", input: { document: unknown; expectedRevision: number }): Promise<unknown>;
}

/**
 * The port over BB's RPC client. `client` is read on every call, so a hook
 * may hand a new client object on each render. An answer that does not match
 * the wire schema is a failure of the call, not a document.
 */
export function createWorkspaceRpcPort(client: () => WorkspaceRpcClient): WorkspaceRpcPort {
  return {
    load: async () => loadWorkspaceOutputSchema.parse(await client().call("load_workspace", {})),
    save: async (document, expectedRevision) =>
      saveWorkspaceOutputSchema.parse(await client().call("save_workspace", { document, expectedRevision })),
  };
}

/** After this many conflicts in a row the window stops merging and asks the user. */
export const MAX_CONFLICTS_IN_A_ROW = 3;

export type SaveState =
  /** Storage holds what the window shows, or nothing was changed yet. */
  | { readonly status: "saved" }
  | { readonly status: "saving" }
  /**
   * The last save did not reach storage: the call failed (`transport`) or the
   * server refused the document (`rejected`). The window keeps its state.
   */
  | { readonly status: "failed"; readonly kind: "transport" | "rejected"; readonly reason: string }
  /** Other windows kept saving first. The window keeps its state; the user reloads or saves again. */
  | { readonly status: "conflict" }
  /** Storage holds a document this code must not replace: nothing is saved. */
  | { readonly status: "off" };

/** What a merge with another window's document changed in this window. */
export interface MergeReport {
  /** Layouts both windows changed: this window's version lives on under `to`. */
  readonly renamedLayouts: readonly (IdRename & { readonly name: string })[];
  readonly renamedPanels: readonly IdRename[];
}

export interface WorkspaceSnapshot {
  /** `idle` until the first entry; `failed` when the document could not be loaded. */
  readonly phase: "idle" | "loading" | "ready" | "failed";
  readonly loadError: string | null;
  readonly document: WorkspaceDocument | null;
  readonly origin: WorkspaceEntry["origin"] | null;
  readonly dropped: readonly DroppedPart[];
  readonly save: SaveState;
  /** The last merge the user has not dismissed. */
  readonly merge: MergeReport | null;
  /** The last change the core refused, until dismissed. */
  readonly refusal: WorkspaceChangeRefusal | null;
}

export interface WorkspaceControllerPorts {
  readonly rpc: WorkspaceRpcPort;
  /** The layout of a workspace nobody has arranged yet. */
  readonly first: { readonly layoutId: string; readonly name: string };
  /** The panels with an open instance in this window, by this window's ids. */
  livePanelIds(): ReadonlySet<string>;
  /** A merge gave some of this window's panels a new id; live instances move to it. */
  onPanelsRenamed?(renames: readonly IdRename[]): void;
}

/** A change of the document: an operation of the core over the current document. */
export type DocumentChange = (document: WorkspaceDocument, livePanelIds: ReadonlySet<string>) => WorkspaceChange;

const IDLE: WorkspaceSnapshot = {
  phase: "idle",
  loadError: null,
  document: null,
  origin: null,
  dropped: [],
  save: { status: "saved" },
  merge: null,
  refusal: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

export class WorkspaceController {
  private snapshot: WorkspaceSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  /** The document storage held when this window last heard from it; a save names its revision. */
  private base: WorkspaceDocument | null = null;
  private canSave = false;
  private entering: Promise<void> | null = null;
  /** The document changed since the save that is on its way, or since the last failed one. */
  private dirty = false;
  private saving: Promise<void> | null = null;

  constructor(private readonly ports: WorkspaceControllerPorts) {}

  getSnapshot = (): WorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Loads the workspace the first time the route is entered. Later calls do
   * nothing while it is loading or loaded; after a failed load they try again.
   */
  enter(): Promise<void> {
    if (this.entering !== null) return this.entering;
    if (this.snapshot.phase === "ready") return Promise.resolve();
    this.entering = this.load().finally(() => {
      this.entering = null;
    });
    return this.entering;
  }

  /**
   * Takes the stored document in place of this window's. The user asks for
   * it after a conflict the window gave up on; unsaved local changes go.
   */
  async reload(): Promise<void> {
    if (this.entering !== null) return this.entering;
    await this.saving;
    this.dirty = false;
    this.entering = this.load().finally(() => {
      this.entering = null;
    });
    return this.entering;
  }

  /**
   * Applies a change and schedules its save. Returns the reason when the
   * core refused it, `null` otherwise. References nothing shows any more are
   * dropped with every change.
   */
  change(apply: DocumentChange): WorkspaceChangeRefusal | null {
    const current = this.snapshot.document;
    if (current === null) return null;
    const live = this.ports.livePanelIds();
    const result = apply(current, live);
    if (!result.ok) {
      this.set({ refusal: result.reason });
      return result.reason;
    }
    const next = dropUnusedPanels(result.document, live);
    if (next === current) return null;
    this.set({ document: next, refusal: null });
    this.schedule();
    return null;
  }

  /** Drops the references no layout places and no live instance shows. */
  prune(): void {
    this.change((document) => ({ ok: true, document }));
  }

  /** Sends the current state again after a failed save or a conflict the window gave up on. */
  retrySave(): void {
    if (this.snapshot.document !== null) this.schedule();
  }

  dismissMerge(): void {
    if (this.snapshot.merge !== null) this.set({ merge: null });
  }

  dismissRefusal(): void {
    if (this.snapshot.refusal !== null) this.set({ refusal: null });
  }

  /** Resolves when no load and no save is on its way and none is waiting. */
  async whenIdle(): Promise<void> {
    while (this.entering !== null || this.saving !== null) {
      await this.entering;
      await this.saving;
    }
  }

  private async load(): Promise<void> {
    this.set({ phase: "loading", loadError: null });
    let read: WorkspaceReadResult;
    try {
      read = await this.ports.rpc.load();
    } catch (error) {
      this.set({ phase: "failed", loadError: messageOf(error), document: null });
      return;
    }
    const entry = enterWorkspace(read, this.ports.first);
    this.base = entry.document;
    this.canSave = entry.canSave;
    this.set({
      phase: "ready",
      loadError: null,
      document: entry.document,
      origin: entry.origin,
      dropped: entry.dropped,
      save: { status: entry.canSave ? "saved" : "off" },
      merge: null,
      refusal: null,
    });
  }

  private schedule(): void {
    if (!this.canSave) return;
    this.dirty = true;
    if (this.saving !== null) return;
    this.saving = this.saveLoop().finally(() => {
      this.saving = null;
    });
  }

  /** One save at a time; whatever changed meanwhile goes out with the next one. */
  private async saveLoop(): Promise<void> {
    let conflicts = 0;
    while (this.dirty) {
      const sent = this.snapshot.document;
      const base = this.base;
      if (sent === null || base === null) return;
      this.dirty = false;
      this.set({ save: { status: "saving" } });
      let result: WorkspaceSaveResult;
      try {
        result = await this.ports.rpc.save(sent, base.revision);
      } catch (error) {
        this.set({ save: { status: "failed", kind: "transport", reason: messageOf(error) } });
        return;
      }
      if (result.status === "rejected") {
        this.set({ save: { status: "failed", kind: "rejected", reason: result.reason } });
        return;
      }
      const current = this.snapshot.document ?? sent;
      if (result.status === "saved") {
        conflicts = 0;
        this.base = result.document;
        // What the user changed while the save was on its way stays; it only moves to the new revision.
        this.set({ document: current === sent ? result.document : { ...current, revision: result.document.revision } });
        continue;
      }
      conflicts += 1;
      if (conflicts > MAX_CONFLICTS_IN_A_ROW) {
        this.set({ save: { status: "conflict" } });
        return;
      }
      this.takeConflict(base, current, result.current);
      this.dirty = true;
    }
    this.set({ save: { status: "saved" } });
  }

  /** Another window saved first: its document becomes the base and this window's work is merged into it. */
  private takeConflict(base: WorkspaceDocument, mine: WorkspaceDocument, stored: WorkspaceDocument | null): void {
    if (stored === null) {
      // Storage holds nothing any more: the window's document is saved as the first one.
      this.base = { ...base, revision: 0 };
      this.set({ document: { ...mine, revision: 0 } });
      return;
    }
    const merged = mergeDocuments(base, mine, stored, this.ports.livePanelIds());
    this.base = stored;
    if (merged.renamedPanels.length > 0) this.ports.onPanelsRenamed?.(merged.renamedPanels);
    const nameOf = (layoutId: string): string => merged.document.layouts.find((layout) => layout.id === layoutId)?.name ?? layoutId;
    this.set({
      document: merged.document,
      merge: {
        renamedLayouts: merged.renamedLayouts.map((rename) => ({ ...rename, name: nameOf(rename.to) })),
        renamedPanels: merged.renamedPanels,
      },
    });
  }

  private set(patch: Partial<WorkspaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The reference a panel id stands for in the document, when the document knows it. */
export function refOfPanel(document: WorkspaceDocument, panelId: string): PanelRef | null {
  return Object.hasOwn(document.panels, panelId) ? document.panels[panelId].ref : null;
}
