// The guard marker on disk. Two writers share it (this plugin and the owner's
// phrase hook), so every write happens under a lock file and goes through a
// temporary file and a rename. The guard hook only reads.
import { randomBytes } from "node:crypto";
import { appendFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { StoreUnavailable, type LogEvent, type StateStore } from "../../core/ports.ts";
import { parseState, prune, type GuardState } from "../../core/state.ts";

export { StoreUnavailable };
export type { LogEvent, StateStore };

const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30_000;
const OWN_KEYS = new Set(["until", "threads"]);

export interface FileStoreOptions {
  /** Absolute path of the marker, from the plugin's server setting. */
  stateFile: string | null;
  /** Unix seconds. */
  now: () => number;
  /** How long to wait for the other writer; 2 seconds unless a test shortens it. */
  lockWaitMs?: number;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The file's top-level object; anything unreadable is an empty one. */
async function readRaw(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function journalPath(stateFile: string): string {
  const extension = extname(stateFile);
  const base = extension === "" || extension === ".log" ? stateFile : stateFile.slice(0, -extension.length);
  return `${base}.log`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function removeIfStale(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
  } catch {
    // Gone already, or not ours to remove: the next attempt decides.
  }
}

async function acquire(lockPath: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new StoreUnavailable("not_writable");
    }
    await removeIfStale(lockPath);
    if (Date.now() >= deadline) throw new StoreUnavailable("locked");
    await sleep(LOCK_POLL_MS);
  }
}

async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Nothing to remove.
  }
}

export function createFileStore(options: FileStoreOptions): StateStore {
  const trimmed = options.stateFile?.trim() ?? "";
  const stateFile = isAbsolute(trimmed) ? trimmed : null;
  const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;

  async function write(raw: Record<string, unknown>, next: GuardState, log: LogEvent, path: string): Promise<void> {
    const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !OWN_KEYS.has(key)));
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ ...kept, ...next }));
      } finally {
        await handle.close();
      }
      // The journal line goes first: a failed journal leaves the marker as it was.
      await appendFile(journalPath(path), `${JSON.stringify({ at: options.now(), ...log, by: "plugin" })}\n`);
      await rename(temporary, path);
    } catch {
      await discard(temporary);
      throw new StoreUnavailable("not_writable");
    }
  }

  return {
    configured: stateFile !== null,
    async read() {
      if (stateFile === null) return { threads: {} };
      return parseState(await readRaw(stateFile));
    },
    async update(change, log) {
      if (stateFile === null) throw new StoreUnavailable("not_configured");
      const lockPath = `${stateFile}.lock`;
      await acquire(lockPath, waitMs);
      try {
        const raw = await readRaw(stateFile);
        const current = parseState(raw);
        const changed = change(current);
        if (changed === current) return current;
        const next = prune(changed, options.now());
        await write(raw, next, typeof log === "function" ? log(current) : log, stateFile);
        return next;
      } finally {
        await discard(lockPath);
      }
    },
  };
}
