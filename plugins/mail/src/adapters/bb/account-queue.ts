// One promise chain per account, so the account's server work (a sync
// round, an APPEND, an expunge, an SMTP submission) never overlaps
// (resolution 7). Accounts run in parallel. A task that rejects hands its
// rejection to its own caller only; the next task of the account still runs.
// A task must not call run() for its own account: it would wait for itself.
import type { AccountWriteQueue } from "../../core/index.ts";

export function createAccountQueue(): AccountWriteQueue & { idle(accountId: string): boolean } {
  const tails = new Map<string, Promise<void>>();
  const pending = new Map<string, number>();

  return {
    run<T>(accountId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(accountId) ?? Promise.resolve();
      pending.set(accountId, (pending.get(accountId) ?? 0) + 1);
      const result = previous.then(() => task());
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(accountId, tail);
      void tail.then(() => {
        const left = (pending.get(accountId) ?? 1) - 1;
        if (left <= 0) {
          pending.delete(accountId);
          if (tails.get(accountId) === tail) tails.delete(accountId);
        } else {
          pending.set(accountId, left);
        }
      });
      return result;
    },
    /** No task of the account is running or waiting. */
    idle(accountId: string): boolean {
      return (pending.get(accountId) ?? 0) === 0;
    },
  };
}
