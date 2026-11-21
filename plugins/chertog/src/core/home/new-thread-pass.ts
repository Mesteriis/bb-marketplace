// The one-time pass that tells an intended new thread screen from an
// accidental Home: both are the same route in BB.

/** Long enough for a navigation to mount the screen, short enough that a pass whose navigation never happened does not wait for the next Home. */
export const NEW_THREAD_PASS_TTL_MS = 5000;

export interface NewThreadPass {
  /** Announce that the next arrival on the new thread screen is intended. */
  grant(now: number): void;
  /** Take the pass. True when one was granted at most its lifetime ago; the pass is gone either way. */
  consume(now: number): boolean;
}

/** Times are milliseconds on one clock; the caller supplies them. */
export function createNewThreadPass(ttlMs: number = NEW_THREAD_PASS_TTL_MS): NewThreadPass {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("New thread pass lifetime must be a positive number of milliseconds");
  }
  let grantedAt: number | null = null;
  return {
    grant(now) {
      grantedAt = now;
    },
    consume(now) {
      if (grantedAt === null) return false;
      const age = now - grantedAt;
      grantedAt = null;
      return age >= 0 && age <= ttlMs;
    },
  };
}
