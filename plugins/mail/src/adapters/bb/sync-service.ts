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
import {
  syncAccount,
  type ChangeNotifier,
  type MailStore,
  type SyncDeps,
  type SyncOptions,
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
}

export interface SyncLoop {
  /** Runs rounds until signal aborts; resolves promptly then. */
  start(signal: AbortSignal): Promise<void>;
  /** Starts a round now: for one account, or for all when accountId is null. */
  wake(accountId: string | null): void;
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

  /** What the next round syncs: "all", some account ids, or nothing queued. */
  let pending: "all" | Set<string> | null = null;
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

  function wake(accountId: string | null): void {
    if (accountId === null || pending === "all") {
      pending = "all";
    } else {
      pending ??= new Set();
      pending.add(accountId);
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
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });

    async function syncOne(accountId: string, syncOptions: SyncOptions): Promise<void> {
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
        log(
          outcome.status === "ok"
            ? `sync ${accountId}: ok, fetched ${outcome.fetched}, removed ${outcome.removed}, marked read ${outcome.pushedSeen}`
            : `sync ${accountId}: ${outcome.authFailed ? "authentication failed" : "error"}`,
        );
      } catch {
        if (!signal.aborted) log(`sync ${accountId}: failed unexpectedly`);
      }
    }

    /** True when the round had accounts to sync (only those count toward the wake window). */
    async function round(target: "all" | Set<string>): Promise<boolean> {
      if (!isReady()) return false;
      let ids: string[];
      let syncOptions: SyncOptions;
      try {
        ids = guarded.store.listAccounts().map((account) => account.id);
        const { windowDays, batchSize } = settings();
        syncOptions = { windowDays, batchSize };
      } catch {
        log("sync: cannot start a round");
        return false;
      }
      if (target !== "all") ids = ids.filter((id) => target.has(id));
      for (const id of ids) {
        if (signal.aborted) break;
        await Promise.race([syncOne(id, syncOptions), aborted]);
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
