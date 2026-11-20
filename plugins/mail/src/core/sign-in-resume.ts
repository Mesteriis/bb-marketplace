// When sync tries a stopped account's saved password again by itself. A
// server can refuse a good password for a while, so a stop is not final:
// the first try comes with the next full round, the next ones 10 and 30
// minutes after a refusal, then once an hour. The times live for the
// process and start over when the password changes.

const MINUTE_MS = 60_000;

/** The wait after the first, the second and every later refused try. */
export const RESUME_WAITS_MS = [10 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS] as const;

export interface SignInResume {
  /** True when a try with this password is due at `nowMs`. */
  due(accountId: string, passwordSealed: string, nowMs: number): boolean;
  /** A try at `nowMs` did not resume the account: the next one waits. */
  failed(accountId: string, passwordSealed: string, nowMs: number): void;
  /** The account works again or is gone. */
  clear(accountId: string): void;
}

export function createSignInResume(): SignInResume {
  const tries = new Map<string, { passwordSealed: string; count: number; nextAt: number }>();
  return {
    due(accountId, passwordSealed, nowMs) {
      const entry = tries.get(accountId);
      return entry === undefined || entry.passwordSealed !== passwordSealed || nowMs >= entry.nextAt;
    },
    failed(accountId, passwordSealed, nowMs) {
      const before = tries.get(accountId);
      const count = before !== undefined && before.passwordSealed === passwordSealed ? before.count + 1 : 1;
      const wait = RESUME_WAITS_MS[Math.min(count, RESUME_WAITS_MS.length) - 1]!;
      tries.set(accountId, { passwordSealed, count, nextAt: nowMs + wait });
    },
    clear(accountId) {
      tries.delete(accountId);
    },
  };
}
