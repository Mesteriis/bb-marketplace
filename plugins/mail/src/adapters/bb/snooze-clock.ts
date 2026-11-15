// The snooze clock (slice 3e): at start, every minute, after each account's
// round end and on "return now", it plans every in-flight and due snooze of
// an account (planSnoozes, at most SNOOZE_TICK_LIMIT rows) inside that
// account's write queue and applies the steps to the store: a return queues
// the move back with \Seen cleared (sync pushes the STORE before the MOVE),
// a pending move into the snooze folder that came due is cancelled by CAS.
// An account it moved gets a full round (never an Inbox-only one: the move
// leaves the snooze folder, spec resolution 16). Rows that reached `done`
// from `returning` go to `notify`, which toasts them by the new-mail filter.
// Nothing runs while the vault is not ready or for an authFailed account.
// Log lines carry account ids and counts only. Nothing here rejects.
import {
  SNOOZE_TICK_LIMIT,
  planSnoozes,
  roleFolder,
  type AccountWriteQueue,
  type Clock,
  type MailStore,
} from "../../core/index.ts";

export const SNOOZE_TICK_MS = 60_000;

export interface SnoozeClockDeps {
  store: MailStore;
  queue: AccountWriteQueue;
  /** The sync loop's wake (a full round of the account). */
  wake: (accountId: string) => void;
  /** Messages that are back from a snooze (state returning → done), per account. */
  notify: (accountId: string, messageIds: string[]) => void | Promise<void>;
  clock: Clock;
  isReady: () => boolean;
  log?: (line: string) => void;
}

export interface SnoozeClock {
  /** Ticks now and every minute until the signal aborts. */
  start(signal: AbortSignal): Promise<void>;
  /** One tick for these accounts (all when absent). */
  tick(accountIds?: string[]): Promise<void>;
  /** An account's round ended: its returns may be done now. */
  roundEnded(accountId: string): void;
}

export function createSnoozeClock(deps: SnoozeClockDeps): SnoozeClock {
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop the clock.
    }
  };
  let stopped = false;

  /** One account's tick, inside its queue task. */
  async function tickAccount(accountId: string): Promise<void> {
    const store = deps.store;
    const account = store.getAccount(accountId);
    if (account === null || account.authFailed || account.snoozeFolder === null) return;
    const views = store.snoozeViews(accountId, SNOOZE_TICK_LIMIT);
    if (views.length === 0) return;
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    const inbox = roleFolder(store, accountId, "inbox");
    if (inbox === null) return;
    const steps = planSnoozes(views, {
      snoozeFolder: account.snoozeFolder,
      inbox,
      folders: store.listFolders(accountId),
      now,
    });
    let moved = 0;
    const back: string[] = [];
    const counts = { returned: 0, cancelled: 0, dropped: 0 };
    for (const step of steps) {
      if (stopped) return;
      switch (step.kind) {
        case "wait":
          break;
        case "cancel_move": {
          const cleared = store.transaction(() => {
            const ids = store.cancelMove([step.messageId], step.folder, step.destination);
            if (ids.length > 0) store.deleteSnoozes([step.messageId]);
            return ids.length;
          });
          if (cleared > 0) {
            moved++;
            counts.cancelled++;
          }
          break;
        }
        case "to_snoozed":
          store.updateSnooze(step.messageId, { state: "snoozed" }, nowIso);
          break;
        case "return": {
          const queued = store.transaction(() => {
            if (store.queueMove([step.messageId], step.to) === null) return false;
            store.setDesired([step.messageId], { seen: false });
            store.updateSnooze(step.messageId, { state: "returning", returnTo: step.to }, nowIso);
            return true;
          });
          if (queued) {
            moved++;
            counts.returned++;
          }
          break;
        }
        case "done":
          store.deleteSnoozes([step.messageId]);
          back.push(step.messageId);
          break;
        case "drop":
          store.deleteSnoozes([step.messageId]);
          counts.dropped++;
          break;
        case "rearm":
          store.updateSnooze(step.messageId, { state: "snoozed", dueAt: step.dueAt }, nowIso);
          break;
      }
    }
    if (moved > 0) deps.wake(accountId);
    if (counts.returned + counts.cancelled + counts.dropped + back.length > 0) {
      log(
        `snooze ${accountId}: returning ${counts.returned}, back ${back.length}, cancelled ${counts.cancelled}, dropped ${counts.dropped}`,
      );
    }
    if (back.length > 0) await deps.notify(accountId, back);
  }

  async function tick(accountIds?: string[]): Promise<void> {
    if (stopped) return;
    let ready = false;
    try {
      ready = deps.isReady();
    } catch {
      ready = false;
    }
    if (!ready) return;
    let ids: string[];
    try {
      ids = accountIds ?? deps.store.listAccounts().map((account) => account.id);
    } catch {
      return;
    }
    for (const accountId of ids) {
      if (stopped) return;
      try {
        await deps.queue.run(accountId, () => tickAccount(accountId));
      } catch {
        if (!stopped) log(`snooze ${accountId}: tick failed`);
      }
    }
  }

  async function start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    signal.addEventListener(
      "abort",
      () => {
        stopped = true;
      },
      { once: true },
    );
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([tick(), aborted]);
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, SNOOZE_TICK_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
      if (!signal.aborted) await Promise.race([tick(), aborted]);
    }
  }

  function roundEnded(accountId: string): void {
    void tick([accountId]);
  }

  return { start, tick, roundEnded };
}
