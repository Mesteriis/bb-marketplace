// Sign-ins the mail server refused, counted in a row per account. A server
// can refuse a good password for a while (too many sign-ins, a restart on its
// side) with the same reply it gives for a wrong one, so an account whose
// password it has accepted before is stopped only after several refusals, one
// sync round each. The count lives for the process: a restart starts over.

/** Refusals in a row before an account that has synced before is stopped. */
export const AUTH_REFUSALS_TO_STOP = 3;

export interface AuthRefusals {
  /** Counts one more refusal of this password; returns how many there are in a row. */
  refused(accountId: string, passwordSealed: string): number;
  /** The server accepted the sign-in: the count starts over. */
  accepted(accountId: string): void;
}

export function createAuthRefusals(): AuthRefusals {
  const counts = new Map<string, { passwordSealed: string; count: number }>();
  return {
    refused(accountId, passwordSealed) {
      const before = counts.get(accountId);
      const count = before !== undefined && before.passwordSealed === passwordSealed ? before.count + 1 : 1;
      counts.set(accountId, { passwordSealed, count });
      return count;
    },
    accepted(accountId) {
      counts.delete(accountId);
    },
  };
}
