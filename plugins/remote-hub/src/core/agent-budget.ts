// A call and output-size budget so a looping agent cannot flood a session, the page or the audit table (stage 4a, Y5).
// - per thread and in aggregate across threads (fixed windows; the clock is injected);
// - a call RESERVES its worst-case output when it is admitted, so parallel calls cannot all pass a check made before
//   any of them has run; `charge` replaces the reservation with what was really returned;
// - a thread table of bounded size: an expired window is dropped to make room, an active window is never evicted, and
//   threads beyond the bound share ONE overflow window instead of each getting a fresh budget;
// - slots, to limit what may run at the same time (screenshots).

export interface ToolBudgetOptions {
  now: () => number;
  callsPerWindow?: number;
  bytesPerWindow?: number;
  /** Across all threads. */
  globalCallsPerWindow?: number;
  globalBytesPerWindow?: number;
  windowMs?: number;
  /** How many threads are remembered. */
  maxThreads?: number;
}

export type BudgetDecision = { ok: true } | { ok: false; reason: "calls" | "bytes" | "global"; retryAfterMs: number };

interface Window {
  start: number;
  calls: number;
  bytes: number;
}

export class ToolBudget {
  private readonly windows = new Map<string, Window>();
  private overflow: Window | null = null;
  private global: Window | null = null;
  /** Reserved output of calls that have not finished, per thread key (the thread, or "" for the overflow window). */
  private readonly inflight = new Map<string, number>();
  private inflightGlobal = 0;
  private readonly slots = new Map<string, number>();
  private readonly calls: number;
  private readonly bytes: number;
  private readonly globalCalls: number;
  private readonly globalBytes: number;
  private readonly windowMs: number;
  private readonly maxThreads: number;

  constructor(private readonly options: ToolBudgetOptions) {
    this.calls = options.callsPerWindow ?? 60;
    this.bytes = options.bytesPerWindow ?? 2 * 1024 * 1024;
    this.globalCalls = options.globalCallsPerWindow ?? 600;
    this.globalBytes = options.globalBytesPerWindow ?? 8 * 1024 * 1024;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxThreads = options.maxThreads ?? 256;
  }

  /** `reserve` is the most this call may return; it counts against the budget from now until `charge`. */
  admit(threadId: string, reserve = 0): BudgetDecision {
    const key = this.keyOf(threadId);
    const w = this.window(threadId);
    const g = this.globalWindow();
    const held = this.inflight.get(key) ?? 0;
    const threadRetry = Math.max(0, w.start + this.windowMs - this.options.now());
    const globalRetry = Math.max(0, g.start + this.windowMs - this.options.now());
    if (w.bytes + held >= this.bytes || w.bytes + held + reserve > this.bytes) return { ok: false, reason: "bytes", retryAfterMs: threadRetry };
    if (w.calls >= this.calls) return { ok: false, reason: "calls", retryAfterMs: threadRetry };
    if (g.calls >= this.globalCalls || g.bytes + this.inflightGlobal + reserve > this.globalBytes) return { ok: false, reason: "global", retryAfterMs: globalRetry };
    w.calls += 1;
    g.calls += 1;
    if (reserve > 0) {
      this.inflight.set(key, held + reserve);
      this.inflightGlobal += reserve;
    }
    return { ok: true };
  }

  /** What a call returned, counted against the window it finished in; `reserved` is what `admit` held for it. */
  charge(threadId: string, bytes: number, reserved = 0): void {
    const key = this.keyOf(threadId);
    if (reserved > 0) {
      const left = (this.inflight.get(key) ?? 0) - reserved;
      if (left > 0) this.inflight.set(key, left);
      else this.inflight.delete(key);
      this.inflightGlobal = Math.max(0, this.inflightGlobal - reserved);
    }
    const used = Math.max(0, bytes);
    this.window(threadId).bytes += used;
    this.globalWindow().bytes += used;
  }

  /** Takes one of `max` places of a kind of work; null when all are taken. The returned function frees it (once). */
  acquire(kind: string, max: number): (() => void) | null {
    const taken = this.slots.get(kind) ?? 0;
    if (taken >= max) return null;
    this.slots.set(kind, taken + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.slots.set(kind, Math.max(0, (this.slots.get(kind) ?? 1) - 1));
    };
  }

  trackedThreads(): number {
    return this.windows.size;
  }

  private expired(w: Window): boolean {
    return this.options.now() - w.start >= this.windowMs;
  }

  /** Threads past the table bound are accounted together under the key "". */
  private keyOf(threadId: string): string {
    return this.windows.has(threadId) || this.windows.size < this.maxThreads || this.dropExpired() ? threadId : "";
  }

  private dropExpired(): boolean {
    for (const [id, w] of this.windows) if (this.expired(w)) this.windows.delete(id);
    return this.windows.size < this.maxThreads;
  }

  private fresh(): Window {
    return { start: this.options.now(), calls: 0, bytes: 0 };
  }

  private window(threadId: string): Window {
    const known = this.windows.get(threadId);
    if (known !== undefined) {
      if (this.expired(known)) {
        known.start = this.options.now();
        known.calls = 0;
        known.bytes = 0;
      }
      return known;
    }
    if (this.windows.size < this.maxThreads || this.dropExpired()) {
      const w = this.fresh();
      this.windows.set(threadId, w);
      return w;
    }
    if (this.overflow === null || this.expired(this.overflow)) this.overflow = this.fresh();
    return this.overflow;
  }

  private globalWindow(): Window {
    if (this.global === null || this.expired(this.global)) this.global = this.fresh();
    return this.global;
  }
}
