// The guard marker on disk. Two writers share it (this plugin and the owner's
// phrase hook), so every write happens under a lock file and goes through a
// temporary file and a rename. The guard hook only reads.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
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

function parseRaw(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** For showing the state: anything unreadable is closed. */
async function readRaw(path: string): Promise<Record<string, unknown>> {
  try {
    return parseRaw(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * For changing the state: a missing file is empty and garbage is closed, but
 * a file that exists and cannot be read is not "empty": a close decided on
 * that would report success and leave the guard open.
 */
async function readForUpdate(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new StoreUnavailable("not_writable");
  }
  return parseRaw(text);
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

/** Takes the lock and returns the token written into it, which proves ownership later. */
async function acquire(lockPath: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid}.${randomBytes(12).toString("hex")}`;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw new StoreUnavailable("not_writable");
    }
    await removeIfStale(lockPath);
    if (Date.now() >= deadline) throw new StoreUnavailable("locked");
    await sleep(LOCK_POLL_MS);
  }
}

/** False once another writer has declared our lock abandoned and taken its own. */
async function holds(lockPath: string, token: string): Promise<boolean> {
  try {
    return (await readFile(lockPath, "utf8")) === token;
  } catch {
    return false;
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

  async function journal(path: string, log: LogEvent): Promise<void> {
    await appendFile(journalPath(path), `${JSON.stringify({ at: options.now(), ...log, by: "plugin" })}\n`);
  }

  async function write(
    raw: Record<string, unknown>,
    next: GuardState,
    log: LogEvent,
    path: string,
    stillLocked: () => Promise<boolean>,
  ): Promise<void> {
    const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !OWN_KEYS.has(key)));
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    // Closing must work even when the journal does not; nothing opens without a journal line.
    const revoking = log.event === "close";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ ...kept, ...next }));
      } finally {
        await handle.close();
      }
      if (!revoking) await journal(path, log);
      // A writer stalled past the stale-lock age has lost the lock: its state is out of date.
      if (!(await stillLocked())) throw new StoreUnavailable("locked");
      await rename(temporary, path);
    } catch (error) {
      await discard(temporary);
      throw error instanceof StoreUnavailable ? error : new StoreUnavailable("not_writable");
    }
    if (revoking) await journal(path, log).catch(() => {});
  }

  return {
    async writable() {
      if (stateFile === null) return false;
      try {
        await access(dirname(stateFile), constants.W_OK | constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async read() {
      if (stateFile === null) return { threads: {} };
      return parseState(await readRaw(stateFile));
    },
    async update(change, log) {
      if (stateFile === null) throw new StoreUnavailable("not_configured");
      const lockPath = `${stateFile}.lock`;
      const token = await acquire(lockPath, waitMs);
      const stillLocked = () => holds(lockPath, token);
      try {
        const raw = await readForUpdate(stateFile);
        const current = parseState(raw);
        const changed = change(current);
        if (changed === current) return current;
        const next = prune(changed, options.now());
        await write(raw, next, typeof log === "function" ? log(current) : log, stateFile, stillLocked);
        return next;
      } finally {
        if (await stillLocked()) await discard(lockPath);
      }
    },
  };
}
