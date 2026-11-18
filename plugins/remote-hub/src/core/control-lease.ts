// Who may drive a session (stage 4b-1). One owner at a time: the human (the default) or one agent thread holding a
// lease. A lease is revocable, bound to a session and a thread, has a time to live, and lives in memory ONLY: nothing
// is restored after the helper or the plugin restarts. The clock is injected. Every change of owner moves the
// session's generation, so work queued under an older owner can tell that it is stale.

export const LEASE_DEFAULT_SECONDS = 120;
export const LEASE_MAX_SECONDS = 600;
export const LEASE_MIN_SECONDS = 5;
/** After the human takes a session back, agents may not take it again for this long (or until the human allows it). */
export const TAKEOVER_HOLD_MS = 5 * 60_000;

export type LeaseEndReason = "released" | "expired" | "takeover" | "thread_gone" | "revoked" | "session_closed";

export interface LeaseEnd {
  sessionKey: string;
  threadId: string;
  leaseId: string;
  reason: LeaseEndReason;
  /** The session's generation after the change. */
  generation: number;
}

export type Owner =
  | { kind: "human"; generation: number }
  | { kind: "agent"; threadId: string; leaseId: string; expiresAt: number; generation: number };

export type AcquireResult = { ok: true; leaseId: string; expiresAt: number; generation: number } | { ok: false; code: "held_by_another_thread" | "already_held_by_you" | "not_the_owner" | "owner_took_over" };
export type CheckResult = { ok: true; generation: number } | { ok: false; code: "no_lease" | "lease_expired" | "not_the_owner" };

interface Lease {
  threadId: string;
  leaseId: string;
  expiresAt: number;
}
interface Entry {
  generation: number;
  lease: Lease | null;
}

export interface ControlLeasesDeps {
  now: () => number;
  newId: () => string;
}

export class ControlLeases {
  private readonly sessions = new Map<string, Entry>();
  private readonly holds = new Map<string, number>();
  private readonly listeners: Array<(end: LeaseEnd) => void> = [];
  private readonly changeListeners: Array<(sessionKey: string) => void> = [];
  constructor(private readonly deps: ControlLeasesDeps) {}

  /** Called after a lease ended, whatever the reason: held keys must be released and queued input dropped. */
  onEnd(cb: (end: LeaseEnd) => void): void {
    this.listeners.push(cb);
  }

  /** Called after the owner of a session or its lease time changed (acquire, renew, end): what shows the owner refreshes. */
  onChange(cb: (sessionKey: string) => void): void {
    this.changeListeners.push(cb);
  }

  private changed(sessionKey: string): void {
    for (const cb of this.changeListeners) {
      try {
        cb(sessionKey);
      } catch {
        // a display's failure must not undo the change
      }
    }
  }

  /** Sessions an agent holds right now (for a change that touches every lease, such as the owner's setting). */
  heldKeys(): string[] {
    return [...this.sessions.keys()].filter((key) => this.owner(key).kind === "agent");
  }

  owner(sessionKey: string): Owner {
    const entry = this.live(sessionKey);
    return entry.lease === null
      ? { kind: "human", generation: entry.generation }
      : { kind: "agent", threadId: entry.lease.threadId, leaseId: entry.lease.leaseId, expiresAt: entry.lease.expiresAt, generation: entry.generation };
  }

  /** When the human's hold on a session ends (epoch ms), or null. */
  holdUntil(sessionKey: string): number | null {
    const until = this.holds.get(sessionKey);
    if (until === undefined) return null;
    if (this.deps.now() >= until) {
      this.holds.delete(sessionKey);
      return null;
    }
    return until;
  }

  /** The human lets agents drive this session again before the hold runs out. */
  allowAgents(sessionKey: string): void {
    if (this.holds.delete(sessionKey)) this.changed(sessionKey);
  }

  acquire(sessionKey: string, threadId: string, seconds?: number): AcquireResult {
    const entry = this.live(sessionKey);
    if (this.holdUntil(sessionKey) !== null) return { ok: false, code: "owner_took_over" };
    if (entry.lease !== null) return { ok: false, code: entry.lease.threadId === threadId ? "already_held_by_you" : "held_by_another_thread" };
    entry.generation += 1;
    entry.lease = { threadId, leaseId: this.deps.newId(), expiresAt: this.deps.now() + this.ttl(seconds) };
    this.changed(sessionKey);
    return { ok: true, leaseId: entry.lease.leaseId, expiresAt: entry.lease.expiresAt, generation: entry.generation };
  }

  renew(sessionKey: string, threadId: string, leaseId: string, seconds?: number): AcquireResult {
    const entry = this.live(sessionKey);
    if (entry.lease === null || entry.lease.threadId !== threadId || entry.lease.leaseId !== leaseId) return { ok: false, code: "not_the_owner" };
    entry.lease.expiresAt = this.deps.now() + this.ttl(seconds);
    this.changed(sessionKey);
    return { ok: true, leaseId, expiresAt: entry.lease.expiresAt, generation: entry.generation };
  }

  release(sessionKey: string, threadId: string, leaseId: string): { ok: true } | { ok: false; code: "no_lease" | "not_the_owner" } {
    const entry = this.live(sessionKey);
    if (entry.lease === null) return { ok: false, code: "no_lease" };
    if (entry.lease.threadId !== threadId || entry.lease.leaseId !== leaseId) return { ok: false, code: "not_the_owner" };
    this.end(sessionKey, entry, "released");
    return { ok: true };
  }

  /** The human takes the session back, at once. Idempotent. */
  takeover(sessionKey: string): { ok: true; previous: { threadId: string; leaseId: string } | null } {
    const entry = this.live(sessionKey);
    if (entry.lease === null) return { ok: true, previous: null };
    const previous = { threadId: entry.lease.threadId, leaseId: entry.lease.leaseId };
    this.holds.set(sessionKey, this.deps.now() + TAKEOVER_HOLD_MS);
    this.end(sessionKey, entry, "takeover");
    return { ok: true, previous };
  }

  /** Ends the lease only if it is exactly this one (a late abort of an old call must not end a successor's lease). */
  endLease(sessionKey: string, threadId: string, leaseId: string, reason: LeaseEndReason): boolean {
    const entry = this.sessions.get(sessionKey);
    if (entry === undefined || entry.lease === null || entry.lease.threadId !== threadId || entry.lease.leaseId !== leaseId) return false;
    this.end(sessionKey, entry, reason);
    return true;
  }

  /** Whether `threadId` holds the lease `leaseId` on this session right now. */
  check(sessionKey: string, threadId: string, leaseId: string): CheckResult {
    const entry = this.sessions.get(sessionKey);
    if (entry === undefined || entry.lease === null) return { ok: false, code: "no_lease" };
    if (this.deps.now() >= entry.lease.expiresAt) {
      this.end(sessionKey, entry, "expired");
      return { ok: false, code: "lease_expired" };
    }
    if (entry.lease.threadId !== threadId || entry.lease.leaseId !== leaseId) return { ok: false, code: "not_the_owner" };
    return { ok: true, generation: entry.generation };
  }

  /** Ends every lease whose time is up (listeners are told); the page's timer calls it. */
  sweep(): void {
    for (const [key, entry] of [...this.sessions]) {
      if (entry.lease !== null && this.deps.now() >= entry.lease.expiresAt) this.end(key, entry, "expired");
    }
  }

  endForThread(threadId: string, reason: LeaseEndReason): number {
    return this.endWhere((_key, lease) => lease.threadId === threadId, reason);
  }

  endSession(sessionKey: string, reason: LeaseEndReason): boolean {
    const entry = this.sessions.get(sessionKey);
    if (entry === undefined || entry.lease === null) return false;
    this.end(sessionKey, entry, reason);
    return true;
  }

  /** The session is gone: its lease (if any) ends and nothing about it is kept. */
  forget(sessionKey: string): void {
    this.endSession(sessionKey, "session_closed");
    this.sessions.delete(sessionKey);
    this.holds.delete(sessionKey);
  }

  /** Ends the leases for which `pick` says so; the number ended. */
  endWhere(pick: (sessionKey: string, lease: { threadId: string; leaseId: string }) => boolean, reason: LeaseEndReason): number {
    let count = 0;
    for (const [key, entry] of [...this.sessions]) {
      if (entry.lease !== null && pick(key, entry.lease)) {
        this.end(key, entry, reason);
        count += 1;
      }
    }
    return count;
  }

  /** Every session that has a lease now (for the page's overview). */
  held(): Array<{ sessionKey: string; threadId: string; leaseId: string; expiresAt: number }> {
    this.sweep();
    return [...this.sessions].flatMap(([sessionKey, e]) => (e.lease === null ? [] : [{ sessionKey, ...e.lease }]));
  }

  private ttl(seconds: number | undefined): number {
    const s = Math.min(LEASE_MAX_SECONDS, Math.max(LEASE_MIN_SECONDS, seconds ?? LEASE_DEFAULT_SECONDS));
    return s * 1000;
  }

  /** The entry, with an expired lease already ended. */
  private live(sessionKey: string): Entry {
    let entry = this.sessions.get(sessionKey);
    if (entry === undefined) {
      entry = { generation: 0, lease: null };
      this.sessions.set(sessionKey, entry);
    }
    if (entry.lease !== null && this.deps.now() >= entry.lease.expiresAt) this.end(sessionKey, entry, "expired");
    return entry;
  }

  private end(sessionKey: string, entry: Entry, reason: LeaseEndReason): void {
    const lease = entry.lease;
    if (lease === null) return;
    entry.lease = null;
    entry.generation += 1;
    const event: LeaseEnd = { sessionKey, threadId: lease.threadId, leaseId: lease.leaseId, reason, generation: entry.generation };
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // a listener's failure must not keep the owner changed back
      }
    }
    this.changed(sessionKey);
  }
}
