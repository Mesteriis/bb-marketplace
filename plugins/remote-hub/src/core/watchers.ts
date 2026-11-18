// Who is looking at a session's live view (stage 4c: agents are never hidden).
//
// A view reports in over its stream socket every couple of seconds with whether its page is visible. A session is
// WATCHED while at least one view reported "visible" no longer ago than WATCH_TTL_MS. Agent input, remote commands and
// the driving lease depend on it: nobody watching means nothing is typed or run, and the lease is suspended at once.
// Host-free: the clock is a dependency, and `sweep` (called on a timer) turns an expiry into a reported change.
export const WATCH_TTL_MS = 6000;
const MAX_VIEWS_PER_SESSION = 16;

interface View {
  visible: boolean;
  at: number;
}

export interface WatcherBookDeps {
  now: () => number;
}

export class WatcherBook {
  private readonly now: () => number;
  /** session key -> view id -> last report. */
  private readonly views = new Map<string, Map<string, View>>();
  private readonly last = new Map<string, boolean>();
  private readonly listeners = new Set<(sessionKey: string, watching: boolean) => void>();

  constructor(deps: WatcherBookDeps) {
    this.now = deps.now;
  }

  /** A view reports in. `visible` is the page's visibility; a hidden page does not count as watching. */
  beat(sessionKey: string, viewId: string, visible: boolean): void {
    let views = this.views.get(sessionKey);
    if (views === undefined) {
      views = new Map();
      this.views.set(sessionKey, views);
    }
    if (!views.has(viewId) && views.size >= MAX_VIEWS_PER_SESSION) {
      // The oldest report goes: a flood of fake views cannot crowd out a real one for long.
      let oldest: string | null = null;
      for (const [id, v] of views) if (oldest === null || v.at < views.get(oldest)!.at) oldest = id;
      if (oldest !== null) views.delete(oldest);
    }
    views.set(viewId, { visible, at: this.now() });
    this.settle(sessionKey);
  }

  /** The view closed. */
  remove(viewId: string): void {
    for (const [key, views] of this.views) {
      if (views.delete(viewId)) {
        if (views.size === 0) this.views.delete(key);
        this.settle(key);
      }
    }
  }

  /** The session is gone. */
  forgetSession(sessionKey: string): void {
    this.views.delete(sessionKey);
    this.settle(sessionKey);
  }

  watching(sessionKey: string): boolean {
    const views = this.views.get(sessionKey);
    if (views === undefined) return false;
    const now = this.now();
    for (const v of views.values()) if (v.visible && now - v.at <= WATCH_TTL_MS) return true;
    return false;
  }

  viewCount(sessionKey: string): number {
    return this.views.get(sessionKey)?.size ?? 0;
  }

  /** Every session that has (or had) views, so an expiry is noticed. Call on a timer. */
  sweep(): void {
    const now = this.now();
    for (const [key, views] of this.views) {
      for (const [id, v] of views) if (now - v.at > WATCH_TTL_MS * 4) views.delete(id);
      if (views.size === 0) this.views.delete(key);
    }
    for (const key of new Set([...this.views.keys(), ...this.last.keys()])) this.settle(key);
  }

  onChange(cb: (sessionKey: string, watching: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Tells the listeners when a session's answer to `watching` is not what they were last told. */
  private settle(sessionKey: string): void {
    const now = this.watching(sessionKey);
    if ((this.last.get(sessionKey) ?? false) === now) return;
    if (now) this.last.set(sessionKey, true);
    else this.last.delete(sessionKey);
    for (const cb of this.listeners) {
      try {
        cb(sessionKey, now);
      } catch {
        // one listener's throw must not skip the others
      }
    }
  }
}
