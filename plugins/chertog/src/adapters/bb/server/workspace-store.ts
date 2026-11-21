// The workspace store over the plugin's key-value storage (`bb.storage.kv`).
//
// The storage has no compare-and-set, so the check of the revision and the
// write are made one step here: every window saves through this one server
// process, and the store runs its saves one after another. Two adapters over
// one storage (a plugin reload with a save still in flight) are not covered.
import type { PluginKvStorage, PluginLogger } from "@get-bb/plugin-sdk";
import type { WorkspaceDocument, WorkspaceReadResult, WorkspaceSaveResult, WorkspaceStore } from "../../../core/workspace/index.ts";
import { decideSave, readWorkspaceDocument } from "../../../core/workspace/index.ts";

// The host namespaces the rows by plugin, so these keys cannot name a row of BB or of another plugin.
const DOCUMENT_KEY = "workspace/document";
const BACKUP_PREFIX = "workspace/backup/";

/** The host keeps a value of at most 256 KB. */
const MAX_DOCUMENT_BYTES = 256 * 1024;
/** How many originals are kept aside; the oldest go first. */
const MAX_BACKUPS = 5;

export interface KvWorkspaceStoreDeps {
  readonly kv: PluginKvStorage;
  /** The instant a copy of a stored original is dated with. */
  readonly now: () => Date;
  readonly log: Pick<PluginLogger, "warn">;
}

export function createKvWorkspaceStore({ kv, now, log }: KvWorkspaceStoreDeps): WorkspaceStore {
  /** Settles when the last queued save has finished, whatever its outcome. */
  let lastSave: Promise<void> = Promise.resolve();

  /**
   * Copies the stored original under a dated key and drops the copies beyond
   * the limit. The log line carries counts and versions only, never a part of
   * the document.
   */
  async function keepAside(original: unknown, partsLeftOut: number, migratedFrom: number | null): Promise<void> {
    const existing = await kv.list(BACKUP_PREFIX);
    const dated = BACKUP_PREFIX + now().toISOString();
    let key = dated;
    for (let copy = 2; existing.includes(key); copy += 1) key = dated + "-" + copy;
    await kv.set(key, original);
    // ISO instants sort by time, and a second copy of one instant sorts after the first.
    const copies = [...existing, key].sort();
    const excess = copies.slice(0, Math.max(0, copies.length - MAX_BACKUPS));
    for (const old of excess) await kv.delete(old);
    log.warn(
      "workspace: the stored original is kept aside before a save over it; parts left out: " +
        partsLeftOut +
        "; stored schema version: " +
        (migratedFrom ?? "current") +
        "; copies kept: " +
        (copies.length - excess.length),
    );
  }

  async function saveNow(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult> {
    const original = await kv.get<unknown>(DOCUMENT_KEY);
    const stored = readWorkspaceDocument(original);
    // Neither of these is ever written over: the stored row stays as it is.
    if (stored.status === "newer") {
      return {
        status: "rejected",
        reason: "Storage holds a workspace written by a newer version of the plugin (schema version " + stored.schemaVersion + ")",
      };
    }
    if (stored.status === "corrupt") {
      return { status: "rejected", reason: "Storage holds a workspace that cannot be read: " + stored.reason };
    }

    const result = decideSave(stored.status === "ok" ? stored.document : null, document, expectedRevision);
    if (result.status !== "saved") return result;
    const bytes = new TextEncoder().encode(JSON.stringify(result.document)).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      return { status: "rejected", reason: "The workspace takes " + bytes + " bytes and storage keeps at most " + MAX_DOCUMENT_BYTES };
    }

    // This write replaces what the reader could not carry over: the parts it left out, and the shape
    // of an older version, which a migration may have dropped fields of. The original goes aside first.
    if (stored.status === "ok" && (stored.dropped.length > 0 || stored.migratedFrom !== null)) {
      await keepAside(original, stored.dropped.length, stored.migratedFrom);
    }
    await kv.set(DOCUMENT_KEY, result.document);
    return result;
  }

  return {
    async load(): Promise<WorkspaceReadResult> {
      return readWorkspaceDocument(await kv.get<unknown>(DOCUMENT_KEY));
    },

    save(document: WorkspaceDocument, expectedRevision: number): Promise<WorkspaceSaveResult> {
      const save = lastSave.then(() => saveNow(document, expectedRevision));
      lastSave = save.then(
        () => undefined,
        () => undefined,
      );
      return save;
    },
  };
}
