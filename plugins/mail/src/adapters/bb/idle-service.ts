// The IDLE supervisor (slice 3e): one read-only watch per account on its
// stored Inbox folder, while instantMail is on and the vault is ready, for
// accounts that are not authFailed and have had an ok round in this process.
// A change wakes an Inbox-only round, debounced per account and change kind;
// a watch that ends is restarted by the backoff of nextIdleStep, and every
// reconnect wakes an Inbox round (mail that came while disconnected). A
// refused login stops the watch and wakes one full round, which records the
// refusal; the watch never retries a refused login by itself. `unsupported`
// stops the account's watch until the plugin reloads.
//
// Log lines carry account ids and fixed codes only, never folder names or
// server text. Nothing here rejects.
import {
  IDLE_DEBOUNCE_MS,
  imapConfigOf,
  nextIdleStep,
  type Clock,
  type ImapGateway,
  type MailStore,
  type SecretVault,
  type StoredAccount,
  type WatchEnd,
} from "../../core/index.ts";

export interface IdleSupervisorDeps {
  gateway: ImapGateway;
  store: MailStore;
  vault: SecretVault;
  /** The sync loop's wake. */
  wake: (accountId: string | null, options?: { only?: "inbox" }) => void;
  log?: (line: string) => void;
  /** The instantMail setting. */
  enabled: () => boolean;
  /** False while there is no vault key. */
  isReady: () => boolean;
  clock: Clock;
}

export interface IdleSupervisor {
  /** Watches until the signal aborts; resolves once every watch has ended. */
  start(signal: AbortSignal): Promise<void>;
  /** Re-reads accounts and settings: starts, restarts or stops watches. */
  refresh(): void;
  /** The account's first ok round of this process: its watch may start. */
  firstRoundOk(accountId: string): void;
}

type ChangeKind = keyof typeof IDLE_DEBOUNCE_MS;

/** Longest wait for the watches to end after an abort. */
const STOP_WAIT_MS = 3_000;

type Watch = {
  /** What the watch was started with; a change restarts it. */
  key: string;
  controller: AbortController;
  running: Promise<void> | null;
  attempt: number;
  lastStartedAt: number | null;
  retry: ReturnType<typeof setTimeout> | null;
  debounce: Map<ChangeKind, ReturnType<typeof setTimeout>>;
};

export function createIdleSupervisor(deps: IdleSupervisorDeps): IdleSupervisor {
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop the watches.
    }
  };
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const watches = new Map<string, Watch>();
  /** Accounts with an ok round in this process. */
  const ready = new Set<string>();
  /** Accounts whose server has no IDLE: no watch until the plugin reloads. */
  const unsupported = new Set<string>();
  /** Accounts stopped by a refused login, with the sealed password it was refused for. */
  const authStopped = new Map<string, string>();
  let signal: AbortSignal | null = null;

  function wakeInbox(accountId: string): void {
    safe(() => deps.wake(accountId, { only: "inbox" }), undefined);
  }

  function inboxOf(accountId: string): string | null {
    return safe(
      () => deps.store.listFolders(accountId).find((f) => f.specialUse === "inbox" && f.selectable)?.path ?? null,
      null,
    );
  }

  function keyOf(account: StoredAccount, inbox: string): string {
    return JSON.stringify([account.host, account.port, account.username, account.passwordSealed, inbox]);
  }

  function clearTimers(watch: Watch): void {
    if (watch.retry !== null) clearTimeout(watch.retry);
    watch.retry = null;
    for (const timer of watch.debounce.values()) clearTimeout(timer);
    watch.debounce.clear();
  }

  function stop(accountId: string): void {
    const watch = watches.get(accountId);
    if (watch === undefined) return;
    watches.delete(accountId);
    clearTimers(watch);
    watch.controller.abort();
  }

  function onChange(accountId: string, watch: Watch, change: ChangeKind): void {
    if (watches.get(accountId) !== watch || watch.debounce.has(change)) return;
    const timer = setTimeout(() => {
      watch.debounce.delete(change);
      if (watches.get(accountId) === watch) wakeInbox(accountId);
    }, IDLE_DEBOUNCE_MS[change]);
    watch.debounce.set(change, timer);
  }

  function begin(accountId: string, watch: Watch, path: string, reconnect: boolean): void {
    const account = safe(() => deps.store.getAccount(accountId), null);
    if (account === null || watches.get(accountId) !== watch) return;
    let config;
    try {
      config = imapConfigOf(account, deps.vault);
    } catch {
      // The sync loop records an undecryptable credential; nothing to watch.
      stop(accountId);
      return;
    }
    watch.lastStartedAt = deps.clock.now().getTime();
    log(`idle ${accountId}: watching`);
    if (reconnect) wakeInbox(accountId);
    watch.running = (async () => {
      let end: WatchEnd;
      try {
        end = await deps.gateway.watchFolder(config, path, (change) => onChange(accountId, watch, change), watch.controller.signal);
      } catch {
        end = { kind: "dropped", code: "Unknown" };
      }
      if (watch.controller.signal.aborted || watches.get(accountId) !== watch) return;
      ended(accountId, watch, path, end);
    })();
  }

  function ended(accountId: string, watch: Watch, path: string, end: WatchEnd): void {
    const step = nextIdleStep({ attempt: watch.attempt, lastStartedAt: watch.lastStartedAt }, end, deps.clock.now().getTime());
    if (step.kind === "stop") {
      watches.delete(accountId);
      clearTimers(watch);
      if (end.kind === "unsupported") {
        unsupported.add(accountId);
        log(`idle ${accountId}: unsupported`);
      } else {
        if (end.kind === "auth") {
          const sealed = safe(() => deps.store.getAccount(accountId)?.passwordSealed ?? "", "");
          authStopped.set(accountId, sealed);
        }
        log(`idle ${accountId}: stopped`);
      }
      if (step.wakeFull) safe(() => deps.wake(accountId), undefined);
      return;
    }
    watch.attempt = step.attempt;
    const code = end.kind === "dropped" ? end.code : end.kind;
    log(`idle ${accountId}: dropped (${code}) retry in ${Math.round(step.delayMs / 1000)}s`);
    watch.retry = setTimeout(() => {
      watch.retry = null;
      if (watches.get(accountId) === watch && signal !== null && !signal.aborted) begin(accountId, watch, path, true);
    }, step.delayMs);
  }

  function refresh(): void {
    if (signal === null || signal.aborted) return;
    const on = safe(() => deps.enabled() && deps.isReady(), false);
    const accounts = on ? safe(() => deps.store.listAccounts(), [] as StoredAccount[]) : [];
    const wanted = new Map<string, { key: string; path: string }>();
    for (const account of accounts) {
      const refusedFor = authStopped.get(account.id);
      if (refusedFor !== undefined && refusedFor !== account.passwordSealed) authStopped.delete(account.id);
      if (account.authFailed || !ready.has(account.id) || unsupported.has(account.id) || authStopped.has(account.id)) {
        continue;
      }
      const path = inboxOf(account.id);
      if (path === null) continue;
      wanted.set(account.id, { key: keyOf(account, path), path });
    }
    for (const [accountId, watch] of [...watches]) {
      const want = wanted.get(accountId);
      if (want === undefined || want.key !== watch.key) stop(accountId);
    }
    for (const [accountId, want] of wanted) {
      if (watches.has(accountId)) continue;
      const watch: Watch = {
        key: want.key,
        controller: new AbortController(),
        running: null,
        attempt: 0,
        lastStartedAt: null,
        retry: null,
        debounce: new Map(),
      };
      watches.set(accountId, watch);
      begin(accountId, watch, want.path, false);
    }
  }

  async function start(startSignal: AbortSignal): Promise<void> {
    signal = startSignal;
    if (startSignal.aborted) return;
    refresh();
    await new Promise<void>((resolve) => startSignal.addEventListener("abort", () => resolve(), { once: true }));
    const running = [...watches.values()].map((watch) => watch.running);
    for (const accountId of [...watches.keys()]) stop(accountId);
    // The gateway ends an aborted watch within its logout cap; never wait longer than this.
    await Promise.race([
      Promise.all(running.map((promise) => promise ?? Promise.resolve())),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_WAIT_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  }

  function firstRoundOk(accountId: string): void {
    if (ready.has(accountId)) return;
    ready.add(accountId);
    refresh();
  }

  return { start, refresh, firstRoundOk };
}
