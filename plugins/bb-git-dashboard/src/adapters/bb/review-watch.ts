/**
 * Leases on native watches of working copies, on the copy's host: a Review that is open renews its copy's lease, and
 * each burst of changes in the working tree, the index or HEAD becomes one `changed(root)`. A lease not renewed in
 * `ttlMs` ends its watch. Follows diff-review's watch lease (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
export type WatchEvent = {kind: "changed"} | {kind: "rescan-required"} | {kind: "watch-error"; message: string};
export type Watch = (root: string, listener: (event: WatchEvent) => void) => Promise<{dispose(): Promise<void>}>;
/** Git's object store and logs change on every read-only command; they say nothing about the diff. */
export const WATCH_IGNORED = [".git/objects", ".git/logs", ".git/fsmonitor--daemon"];

export class WatchLeases {
  private readonly leases = new Map<string, {until: number; stop: Promise<{dispose(): Promise<void>}>}>();
  private readonly watch: Watch;
  private readonly changed: (root: string) => void;
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(watch: Watch, changed: (root: string) => void, now: () => number = Date.now, ttlMs = 90_000) {
    this.watch = watch;
    this.changed = changed;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /** Starts or renews the watch of `root`; a watch that failed to start is tried again on the next renewal. */
  async renew(root: string) {
    this.sweep();
    const lease = this.leases.get(root);
    if (lease) { lease.until = this.now() + this.ttlMs; return; }
    const stop = this.watch(root, event => { if (event.kind !== "watch-error") this.changed(root); });
    this.leases.set(root, {until: this.now() + this.ttlMs, stop});
    try { await stop; }
    catch (error) { this.leases.delete(root); throw error; }
  }

  /** Ends the watches whose lease ran out; returns their roots. */
  sweep(): string[] {
    const ended: string[] = [];
    for (const [root, lease] of this.leases) {
      if (lease.until > this.now()) continue;
      this.leases.delete(root);
      ended.push(root);
      void lease.stop.then(watch => watch.dispose()).catch(() => { /* already gone */ });
    }
    return ended;
  }

  /** Ends every watch: the worker is going away. */
  stopAll() {
    for (const lease of this.leases.values()) lease.until = 0;
    return this.sweep();
  }

  watching = () => [...this.leases.keys()];
}
