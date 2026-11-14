// The background sync loop: rounds over the stored accounts, one at a time,
// then a sleep of syncIntervalMinutes (at least one minute) that a wake or the
// abort signal cuts short. A wake during a round queues another round right
// after it. Nothing here rejects: every account is synced inside its own
// try/catch, so one failing account (or a store error) never stops the rest
// or escapes the service. Log lines name account ids and outcome codes only.
import { syncAccount, type SyncDeps, type SyncOptions } from "../../core/index.ts";

/** Stored on an account whose sealed password the current vault key cannot open. */
export const DECRYPT_ERROR = "Cannot decrypt credential — re-enter the password";

const MINUTE_MS = 60_000;

export type SyncLoopSettings = SyncOptions & { intervalMinutes: number };

export interface SyncLoop {
  /** Runs rounds until signal aborts; resolves then. */
  start(signal: AbortSignal): Promise<void>;
  /** Starts a round now: for one account, or for all when accountId is null. */
  wake(accountId: string | null): void;
}

export function createSyncLoop(
  deps: SyncDeps,
  settings: () => SyncLoopSettings,
  log: (line: string) => void = () => {},
): SyncLoop {
  /** What the next round syncs: "all", some account ids, or nothing queued. */
  let pending: "all" | Set<string> | null = null;
  let cutSleep: (() => void) | null = null;

  function wake(accountId: string | null): void {
    if (accountId === null || pending === "all") {
      pending = "all";
    } else {
      pending ??= new Set();
      pending.add(accountId);
    }
    cutSleep?.();
  }

  function takePending(): "all" | Set<string> {
    const next = pending ?? "all";
    pending = null;
    return next;
  }

  async function syncOne(accountId: string, options: SyncOptions): Promise<void> {
    try {
      const account = deps.store.getAccount(accountId);
      if (account === null || account.authFailed) return;
      if (!canOpen(account.passwordSealed)) {
        deps.store.recordSyncResult(accountId, {
          lastSyncAt: account.lastSyncAt,
          lastError: DECRYPT_ERROR,
          authFailed: false,
        });
        log(`sync ${accountId}: credential cannot be decrypted`);
        return;
      }
      const outcome = await syncAccount(deps, accountId, options);
      log(
        outcome.status === "ok"
          ? `sync ${accountId}: ok, fetched ${outcome.fetched}, removed ${outcome.removed}`
          : `sync ${accountId}: ${outcome.authFailed ? "authentication failed" : "error"}`,
      );
    } catch {
      log(`sync ${accountId}: failed unexpectedly`);
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

  async function round(target: "all" | Set<string>, signal: AbortSignal): Promise<void> {
    let ids: string[];
    try {
      ids = deps.store.listAccounts().map((account) => account.id);
    } catch {
      log("sync: cannot list accounts");
      return;
    }
    if (target !== "all") ids = ids.filter((id) => target.has(id));
    const { windowDays, batchSize } = settings();
    for (const id of ids) {
      if (signal.aborted) return;
      await syncOne(id, { windowDays, batchSize });
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

  async function start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await round(takePending(), signal);
      if (signal.aborted || pending !== null) continue;
      const minutes = settings().intervalMinutes;
      const interval = Number.isFinite(minutes) ? Math.max(1, minutes) : 1;
      await sleep(interval * MINUTE_MS, signal);
    }
  }

  return { start, wake };
}
