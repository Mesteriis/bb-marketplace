// A call and output-size budget per thread, so a looping agent cannot flood a session, the page or the audit
// table (stage 4a). Fixed windows; the clock is injected.

export interface ToolBudgetOptions {
  now: () => number;
  callsPerWindow?: number;
  bytesPerWindow?: number;
  windowMs?: number;
  /** How many threads are remembered; the least recently started window goes first. */
  maxThreads?: number;
}

export type BudgetDecision = { ok: true } | { ok: false; reason: "calls" | "bytes"; retryAfterMs: number };

interface Window {
  start: number;
  calls: number;
  bytes: number;
}

export class ToolBudget {
  private readonly windows = new Map<string, Window>();
  private readonly calls: number;
  private readonly bytes: number;
  private readonly windowMs: number;
  private readonly maxThreads: number;

  constructor(private readonly options: ToolBudgetOptions) {
    this.calls = options.callsPerWindow ?? 60;
    this.bytes = options.bytesPerWindow ?? 2 * 1024 * 1024;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxThreads = options.maxThreads ?? 256;
  }

  admit(threadId: string): BudgetDecision {
    const w = this.window(threadId);
    const retryAfterMs = Math.max(0, w.start + this.windowMs - this.options.now());
    if (w.bytes >= this.bytes) return { ok: false, reason: "bytes", retryAfterMs };
    if (w.calls >= this.calls) return { ok: false, reason: "calls", retryAfterMs };
    w.calls += 1;
    return { ok: true };
  }

  /** What a call returned, counted against the window it ran in. */
  charge(threadId: string, bytes: number): void {
    this.window(threadId).bytes += Math.max(0, bytes);
  }

  trackedThreads(): number {
    return this.windows.size;
  }

  private window(threadId: string): Window {
    const now = this.options.now();
    let w = this.windows.get(threadId);
    if (w === undefined || now - w.start >= this.windowMs) {
      w = { start: now, calls: 0, bytes: 0 };
      this.windows.delete(threadId);
      this.windows.set(threadId, w);
      while (this.windows.size > this.maxThreads) {
        const oldest = this.windows.keys().next().value as string;
        this.windows.delete(oldest);
      }
    }
    return w;
  }
}
