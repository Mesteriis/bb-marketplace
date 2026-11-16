// Dev classes for mail synced before 3g (messages.dev_source NULL, slice 3g
// #37): judged from the stored From address and subject only (no header
// fetch, no server contact), newest first, Spam and Trash left out by the
// store, at most `budget` rows a round. A row judged not a dev notification
// is marked checked ('') so it is not read again. Never throws; returns
// counts only, never mail text.
import { classifyDevFromStored } from "./dev-notify.ts";
import type { MailStore } from "./ports.ts";

/** Rows classified per round. */
export const DEV_BACKFILL_BUDGET = 2_000;
/** Rows per store write. */
const DEV_BACKFILL_BATCH = 500;

export type DevBackfillOutcome = {
  /** Rows judged this round. */
  checked: number;
  /** Of those, dev notifications. */
  classified: number;
  /** Unclassified rows may remain (the budget ran out). */
  more: boolean;
};

export function devBackfill(store: MailStore, options: { budget?: number } = {}): DevBackfillOutcome {
  const budget = Math.max(0, options.budget ?? DEV_BACKFILL_BUDGET);
  const outcome: DevBackfillOutcome = { checked: 0, classified: 0, more: false };
  try {
    const rows = store.devUnclassified(budget + 1);
    outcome.more = rows.length > budget;
    const taken = rows.slice(0, budget);
    for (let i = 0; i < taken.length; i += DEV_BACKFILL_BATCH) {
      const batch = taken.slice(i, i + DEV_BACKFILL_BATCH).map((row) => ({
        id: row.id,
        dev: classifyDevFromStored({ from: row.from, subject: row.subject }),
      }));
      store.transaction(() => store.setDevClass(batch));
      outcome.checked += batch.length;
      outcome.classified += batch.filter((row) => row.dev !== null).length;
    }
  } catch {
    // A store failure ends the round quietly; the rows stay unclassified.
  }
  return outcome;
}
