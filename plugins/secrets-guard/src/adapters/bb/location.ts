// Where the marker lives. A non-empty setting wins; otherwise the guard hook
// says so itself in a pointer file it keeps next to the hooks. The pointer is
// read on every access: the hook may create or move it while the plugin runs.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StoreUnavailable, type StateStore } from "../../core/ports.ts";
import type { GuardState } from "../../core/state.ts";
import { createFileStore } from "./file-store.ts";

const POINTER = [".claude", "hooks", "guard-location.json"] as const;

/** The path the hook published, or null when the pointer says nothing usable. */
async function readPointer(homeDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(homeDir, ...POINTER), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("stateFile" in parsed)) return null;
    const { stateFile } = parsed;
    return typeof stateFile === "string" && isAbsolute(stateFile) ? stateFile : null;
  } catch {
    return null;
  }
}

/**
 * The marker's absolute path, or null for "not configured". A setting that is
 * filled in is an override even when it is wrong: it never falls back to the pointer.
 */
export async function locateStateFile(input: { setting: string; homeDir: string }): Promise<string | null> {
  const setting = input.setting.trim();
  if (setting !== "") return isAbsolute(setting) ? setting : null;
  return readPointer(input.homeDir);
}

export interface LocatedStore extends StateStore {
  /** Closes what is open in the file used last and forgets it; for a changed setting. */
  leave(): Promise<void>;
}

const closeEverything = (state: GuardState): GuardState =>
  state.until === undefined && Object.keys(state.threads).length === 0 ? state : { threads: {} };

/**
 * A store that asks where the marker is before every operation.
 *
 * When the answer moves to another file, what is open in the old one is closed
 * first: the hook would go on honouring it and nothing here could close it.
 * While there is no answer the store is "not configured" and the old file is
 * left alone: an unreadable pointer may be the hook rewriting it.
 */
export function createLocatedStore(options: {
  locate: () => Promise<string | null>;
  now: () => number;
  lockWaitMs?: number;
  /** The old file could not be closed. */
  onLeaveFailed?: () => void;
}): LocatedStore {
  const fileStore = (stateFile: string | null) =>
    createFileStore({ stateFile, now: options.now, lockWaitMs: options.lockWaitMs });
  const nowhere = fileStore(null);
  let last: { path: string; store: StateStore } | null = null;

  async function leave(): Promise<void> {
    const previous = last;
    last = null;
    if (previous === null) return;
    try {
      await previous.store.update(closeEverything, { event: "close", scope: null, root: null, until: null });
    } catch (error) {
      if (!(error instanceof StoreUnavailable)) throw error;
      options.onLeaveFailed?.();
    }
  }

  async function current(): Promise<StateStore> {
    const path = await options.locate();
    if (path === null) return nowhere;
    if (last !== null && last.path === path) return last.store;
    await leave();
    last = { path, store: fileStore(path) };
    return last.store;
  }

  return {
    writable: async () => (await current()).writable(),
    read: async () => (await current()).read(),
    update: async (change, log) => (await current()).update(change, log),
    leave,
  };
}
