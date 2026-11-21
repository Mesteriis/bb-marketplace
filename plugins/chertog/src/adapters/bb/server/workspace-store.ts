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
/** Copies of stored originals: `workspace/backup/<number>-<instant>`. */
const BACKUP_PREFIX = "workspace/backup/";

/** The host keeps a value of at most 256 KB. */
const MAX_DOCUMENT_BYTES = 256 * 1024;
/** How many originals are kept aside; the oldest go first. */
const MAX_BACKUPS = 5;

/** The whole name the store gives a copy: a number, then an ISO instant. Nothing else under the prefix is its own. */
const BACKUP_KEY = /^([0-9]{6,15})-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/** The number of a copy this store wrote, `null` for a key under the prefix it did not write. */
function backupNumber(key: string): number | null {
  const match = BACKUP_KEY.exec(key.slice(BACKUP_PREFIX.length));
  return match === null ? null : Number(match[1]);
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
    // A copy is named by its number, then the instant. The number decides the age: it only grows,
    // so neither two copies of one instant nor a clock that went back can put a new copy before an old one.
    const numbered = (await kv.list(BACKUP_PREFIX))
      .map((key) => ({ key, number: backupNumber(key) }))
      .filter((copy): copy is { key: string; number: number } => copy.number !== null)
      .sort((first, second) => first.number - second.number);
    const number = (numbered.at(-1)?.number ?? 0) + 1;
    const key = BACKUP_PREFIX + String(number).padStart(6, "0") + "-" + now().toISOString();
    await kv.set(key, original);
    // The copy just written has the highest number, so it is never among the ones dropped.
    const copies = [...numbered.map((copy) => copy.key), key];
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

    // This write replaces the stored row with a document made from what the reader returned. Whenever
    // that is not the row itself (a part left out, an older version, a repaired field, anything the
    // reader may change later), the row goes aside first. The reader's report is not relied upon.
    if (stored.status === "ok" && !sameData(original, stored.document)) {
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
