// The background sync loop. A full round syncs every stored account, one at a
// time; the next full round is due syncIntervalMinutes (at least one minute)
// after the last one finished. wake(accountId) runs a targeted round now
// without moving that deadline, wake(null) runs a full round now, and a wake
// during a round queues another round right after it. Wakes are coalesced: at
// most one extra round starts within WAKE_WINDOW_MS of the last round's start;
// later wakes wait for the window to end and then share one round. While the
// vault is not ready, rounds do nothing.
//
// Nothing here rejects: every account is synced inside its own try/catch, and
// the logger and settings are guarded, so one failing account (or a store
// error) never stops the rest or escapes the service. start() resolves as soon
// as the signal aborts, even mid-sync: the in-flight account sync is left to
// finish on its own, and from the abort on every store call it makes throws and
// every notification is dropped, so it cannot write into a store the host has
// closed. Log lines name account ids and outcome codes only.
//
// With a write queue, each account's sync runs through it, so a round never
// overlaps that account's APPEND, expunge or SMTP send (resolution 7).
//
// After an ok round the same queue task backfills bulk marks of mail synced
// before the mark existed (backfillBulk, at most BACKFILL_BUDGET rows per
// account and round), so it never overlaps sync or SMTP either and finishes
// over a few rounds. It logs counts only.
//
// After an ok round the same task also resolves the account's pending alias
// send checks from the synced Sent copies (slice 3d), and once each account's
// sync of a round is over, onRoundEnd(accountId) runs (undo's second wake).
//
// Slice 3e: wake(accountId, { only: "inbox" }) asks an Inbox-only round
// (IDLE); the pending map keeps "all" over "inbox" for an account. After an
// ok round, inside the same queue task and after the send checks,
// onRoundOk(accountId, outcome, only) runs (the server's block, notify and
// snooze hooks); the bulk and unsubscribe backfills run on full rounds only.
//
// Slice 3g: with `classify` on (the devNotifications setting) sync judges
// new rows' dev class, and after a full round the dev backfill classifies up
// to DEV_BACKFILL_BUDGET older rows from their stored From and subject (no
// server contact) while unclassified rows remain.
//
// Slice 3h: full rounds pass historyCheck, so sync checks a folder's loaded
// history against the server at most once a day (spec resolution 9).
import {
  backfillBulk,
  backfillUnsubscribe,
  devBackfill,
  syncAccount,
  type BackfillCursors,
  type AccountWriteQueue,
  type ChangeNotifier,
  type MailStore,
  type SyncDeps,
  type SyncOptions,
  type SyncOutcome,
} from "../../core/index.ts";

/** Stored on an account whose sealed password the current vault key cannot open. */
export const DECRYPT_ERROR = "Cannot decrypt credential — re-enter the password";

const MINUTE_MS = 60_000;

/** Opens and actions come in bursts; this bounds how often they start a round. */
const WAKE_WINDOW_MS = 10_000;

export type SyncLoopSettings = SyncOptions & { intervalMinutes: number };

export interface SyncLoopOptions {
  /** Receives one safe line per account outcome. */
  log?: (line: string) => void;
  /** False while there is no vault key: rounds are skipped. Defaults to always ready. */
  isReady?: () => boolean;
  /** Serializes each account's sync with its other server work. */
  queue?: AccountWriteQueue;
  /** Runs once each account's sync of a round is over (after its queue task); errors are ignored. */
  onRoundEnd?: (accountId: string) => void;
  /**
   * Runs after an ok round inside the account's queue task, after the send
   * checks and before the backfills (slice 3e); errors are ignored.
   */
  onRoundOk?: (
    accountId: string,
    outcome: Extract<SyncOutcome, { status: "ok" }>,
    only: "inbox" | undefined,
  ) => void | Promise<void>;
}

export interface SyncLoop {
  /** Runs rounds until signal aborts; resolves promptly then. */
  start(signal: AbortSignal): Promise<void>;
  /**
   * Starts a round now: for one account, or for all when accountId is null.
   * `only: "inbox"` asks an Inbox-only round of that account; a full wake of
   * it, before or after, wins.
   */
  wake(accountId: string | null, options?: { only?: "inbox" }): void;
  /** Re-reads the interval: the next full round is due interval after the last one. */
  reschedule(): void;
}

export function createSyncLoop(
  deps: SyncDeps,
  settings: () => SyncLoopSettings,
  options: SyncLoopOptions = {},
): SyncLoop {
  const log = (line: string) => {
    try {
      options.log?.(line);
    } catch {
      // A broken logger must not stop sync.
    }
  };
  const isReady = () => {
    try {
      return options.isReady?.() ?? true;
    } catch {
      return false;
    }
  };

  /** What the next round syncs: "all", some accounts (each Inbox-only or all folders), or nothing queued. */
  let pending: "all" | Map<string, "inbox" | "all"> | null = null;
  /** Date.now() when the last full round finished; null before the first. */
  let lastFullAt: number | null = null;
  let cutSleep: (() => void) | null = null;
  /** Date.now() when the last round started, and whether it was itself the extra one. */
  let lastStartAt: number | null = null;
  let lastWasExtra = false;

  /** When a woken round may start: now, unless the window's one extra round is used. */
  function wokenStartAt(now: number): number {
    if (lastStartAt === null || now - lastStartAt >= WAKE_WINDOW_MS || !lastWasExtra) return now;
    return lastStartAt + WAKE_WINDOW_MS;
  }

  /** A woken round inside the last round's window is that window's extra one. */
  function markStart(now: number, woken: boolean): void {
    lastWasExtra = woken && lastStartAt !== null && now - lastStartAt < WAKE_WINDOW_MS;
    lastStartAt = now;
  }

  function wake(accountId: string | null, wakeOptions?: { only?: "inbox" }): void {
    if (accountId === null || pending === "all") {
      pending = "all";
    } else {
      pending ??= new Map();
      const kind = wakeOptions?.only === "inbox" ? "inbox" : "all";
      if (pending.get(accountId) !== "all") pending.set(accountId, kind);
    }
    cutSleep?.();
  }

  function reschedule(): void {
    cutSleep?.();
  }

  function intervalMs(): number {
    try {
      const minutes = settings().intervalMinutes;
      return (Number.isFinite(minutes) ? Math.max(1, minutes) : 1) * MINUTE_MS;
    } catch {
      return MINUTE_MS;
    }
  }

  async function start(signal: AbortSignal): Promise<void> {
    const guarded = guardAfterAbort(deps, signal);
    /** Where each folder's backfill goes on below; for the life of this loop. */
    const cursors: BackfillCursors = new Map();
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });

    async function syncOne(accountId: string, syncOptions: SyncOptions): Promise<void> {
      if (options.queue === undefined) {
        await syncOneNow(accountId, syncOptions);
      } else {
        try {
          await options.queue.run(accountId, () => syncOneNow(accountId, syncOptions));
        } catch {
          // syncOneNow never rejects.
        }
      }
      if (signal.aborted) return;
      try {
        options.onRoundEnd?.(accountId);
      } catch {
        // A broken hook must not stop sync.
      }
    }

    async function syncOneNow(accountId: string, syncOptions: SyncOptions): Promise<void> {
      if (signal.aborted) return;
      try {
        const account = guarded.store.getAccount(accountId);
        if (account === null || account.authFailed) return;
        if (!canOpen(account.passwordSealed)) {
          guarded.store.recordSyncResult(accountId, {
            lastSyncAt: account.lastSyncAt,
            lastError: DECRYPT_ERROR,
            authFailed: false,
          });
          guarded.notifier.mailChanged(accountId);
          log(`sync ${accountId}: credential cannot be decrypted`);
          return;
        }
        const outcome = await syncAccount(guarded, accountId, syncOptions);
        const label = syncOptions.only === "inbox" ? `${accountId} inbox` : accountId;
        // A round cut short by the service stopping (a reload) is not a sync error worth a line.
        if (outcome.status !== "ok" && signal.aborted) return;
        log(
          outcome.status === "ok"
            ? `sync ${label}: ok, fetched ${outcome.fetched}, removed ${outcome.removed}, marked read ${outcome.pushedSeen}, flags ${outcome.pushedFlags}`
            : `sync ${label}: ${outcome.authFailed ? "authentication failed" : "error"}`,
        );
        if (outcome.status !== "ok" || signal.aborted) return;
        guarded.store.resolveSendChecks(accountId, guarded.clock.now().toISOString());
        try {
          await options.onRoundOk?.(accountId, outcome, syncOptions.only);
        } catch {
          if (!signal.aborted) log(`sync ${accountId}: round hook failed`);
        }
        if (signal.aborted || syncOptions.only !== undefined) return;
        const filled = await backfillBulk(guarded, accountId, { cursors, signal });
        logBackfill("backfill", accountId, filled);
        if (signal.aborted) return;
        const unsubscribe = await backfillUnsubscribe(guarded, accountId, { cursors, signal });
        logBackfill("backfill unsubscribe", accountId, unsubscribe);
      } catch {
        if (!signal.aborted) log(`sync ${accountId}: failed unexpectedly`);
      }
    }

    function logBackfill(label: string, accountId: string, filled: Awaited<ReturnType<typeof backfillBulk>>): void {
      if (signal.aborted || (filled.folders === 0 && filled.failed === 0 && filled.skipped === 0)) return;
      log(
        `${label} ${accountId}: marked ${filled.marked}, not on the server ${filled.unanswered}` +
          (filled.skipped > 0 ? `, folders renumbered ${filled.skipped}` : "") +
          (filled.failed > 0 ? `, failed ${filled.failed}` : ""),
      );
    }

    /** False once a dev backfill found no unclassified rows left (new rows are classified at sync); true again while classification is off. */
    let devRowsLeft = true;

    /** True when the round had accounts to sync (only those count toward the wake window). */
    async function round(target: "all" | Map<string, "inbox" | "all">): Promise<boolean> {
      if (!isReady()) return false;
      let ids: string[];
      let syncOptions: SyncOptions;
      try {
        ids = guarded.store.listAccounts().map((account) => account.id);
        const { windowDays, batchSize, classify } = settings();
        syncOptions = classify === true ? { windowDays, batchSize, classify } : { windowDays, batchSize };
      } catch {
        log("sync: cannot start a round");
        return false;
      }
      if (target !== "all") ids = ids.filter((id) => target.has(id));
      for (const id of ids) {
        if (signal.aborted) break;
        // Slice 3h: full rounds may check loaded history (once a day per folder, decided by sync).
        const only = target !== "all" && target.get(id) === "inbox" ? { only: "inbox" as const } : { historyCheck: true };
        await Promise.race([syncOne(id, { ...syncOptions, ...only }), aborted]);
      }
      // Rows synced while classification was off wait for the backfill again.
      if (syncOptions.classify !== true) devRowsLeft = true;
      if (target === "all" && syncOptions.classify === true && !signal.aborted && devRowsLeft) {
        const dev = devBackfill(guarded.store, syncOptions.devHosts === undefined ? {} : { devHosts: syncOptions.devHosts });
        devRowsLeft = dev.more;
        if (dev.checked > 0) log(`backfill dev: checked ${dev.checked}, classified ${dev.classified}`);
      }
      return ids.length > 0;
    }

    while (!signal.aborted) {
      const now = Date.now();
      const due = lastFullAt === null ? 0 : lastFullAt + intervalMs() - now;
      if (due <= 0) {
        // A scheduled full round covers every queued wake.
        pending = null;
        if (await round("all")) markStart(now, false);
        lastFullAt = Date.now();
        continue;
      }
      const wokenAt = pending === null ? null : wokenStartAt(now);
      if (pending !== null && wokenAt !== null && wokenAt <= now) {
        const target = pending;
        pending = null;
        if (await round(target)) markStart(now, true);
        if (target === "all") lastFullAt = Date.now();
        continue;
      }
      await sleep(wokenAt === null ? due : Math.min(due, wokenAt - now), signal);
    }
  }

  function canOpen(sealed: string): boolean {
    try {
      deps.vault.open(sealed);
      return true;
    } catch {
      return false;
    }
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        cutSleep = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      cutSleep = done;
    });
  }

  return { start, wake, reschedule };
}

/** Deps whose store throws and whose notifier is silent once signal has aborted. */
function guardAfterAbort(deps: SyncDeps, signal: AbortSignal): SyncDeps {
  const store = new Proxy(deps.store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (signal.aborted) throw new Error("Sync stopped");
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as MailStore;
  const notifier: ChangeNotifier = {
    mailChanged: (accountId) => {
      if (!signal.aborted) deps.notifier.mailChanged(accountId);
    },
  };
  return { ...deps, store, notifier };
}
