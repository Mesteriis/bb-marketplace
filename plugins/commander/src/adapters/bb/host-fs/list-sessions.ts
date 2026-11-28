import type { Dir } from "node:fs";
import type { FsPath } from "./paths.ts";

/**
 * A directory read that stopped at a page boundary. The next page continues from the same handle instead of reading
 * the directory again from its first entry, which made a listing of n entries cost O(n²) reads (S19a: 100 000 entries,
 * 97 s with the editor path policy of S16 checking every skipped entry).
 */
export interface ListSession {
  dir: Dir;
  /** Name of the entry read ahead of a full page; it opens the next page. */
  carry: Buffer | null;
}

const MAX_SESSIONS = 8;
const IDLE_MS = 30_000;

/** Sessions are found by directory, position and directory version; a missed lookup falls back to a fresh scan. */
export class ListSessions {
  private readonly open = new Map<string, { session: ListSession; timer: NodeJS.Timeout }>();

  static key(full: FsPath, index: number, version: string): string {
    return `${typeof full === "string" ? full : full.toString("hex")}|${index}|${version}`;
  }

  /** Removes and returns a session, so two requests never read one handle. */
  take(key: string): ListSession | undefined {
    const found = this.open.get(key);
    if (!found) return undefined;
    clearTimeout(found.timer);
    this.open.delete(key);
    return found.session;
  }

  put(key: string, session: ListSession): void {
    const previous = this.open.get(key);
    if (previous) this.discard(key, previous);
    while (this.open.size >= MAX_SESSIONS) {
      const oldest = this.open.entries().next().value;
      if (!oldest) break;
      this.discard(oldest[0], oldest[1]);
    }
    const timer = setTimeout(() => {
      const entry = this.open.get(key);
      if (entry?.session === session) this.discard(key, entry);
    }, IDLE_MS);
    timer.unref();
    this.open.set(key, { session, timer });
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.entries()];
    for (const [key, entry] of all) this.discard(key, entry);
  }

  private discard(key: string, entry: { session: ListSession; timer: NodeJS.Timeout }): void {
    clearTimeout(entry.timer);
    this.open.delete(key);
    void entry.session.dir.close().catch(() => {});
  }
}
