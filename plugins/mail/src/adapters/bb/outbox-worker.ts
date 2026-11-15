// The outbox worker, run inside the plugin's background service next to the
// sync loop. On start it recovers the outbox before any other work (a row
// left `sending` becomes `unknown`, never resent; an overdue `queued` row
// becomes `held` and waits for the owner). Then every interval, and at once
// on wake: due sends (runOutboxOnce until it has nothing to do), the
// background copy of idle drafts to the Drafts folder, and the search of a
// Gmail account's Sent folder for sends that became `unknown`.
//
// Resolution 10: on abort the worker takes no new rows, and a send still
// waiting behind the account's write queue never opens SMTP (its row stays
// `queued`, so it is not `unknown` on the next start). A step in flight
// keeps the worker's own (unguarded) store and gets DRAIN_MS to finish, so a
// send that completes in that time is recorded as sent, not left as
// `sending` (which the next start would call `unknown`). After the drain the
// send is aborted; whatever it then records may fail against a closed
// database, which only means the next start recovers it. Nothing here
// rejects; log lines carry outbox ids, counts and error kinds only.
import {
  isHiddenDraft,
  runOutboxOnce,
  settleGmailUnknown,
  writeServerCopy,
  type OutboxDeps,
} from "../../core/index.ts";

export const OUTBOX_INTERVAL_MS = 5_000;
export const DRAIN_MS = 5_000;
/** How often unknown Gmail sends are searched for in Sent. */
export const SETTLE_EVERY_MS = 30_000;
/** How long a draft whose server copy failed waits before the next try. */
export const COPY_RETRY_MS = 60_000;
/** Bounds one step, so a row that never changes state cannot spin. */
const MAX_SENDS_PER_STEP = 20;

export type OutboxWorkerDeps = OutboxDeps & {
  /** False while there is no vault key: the worker does nothing. */
  isReady: () => boolean;
  /** A draft's server copy was written (its old copy may be gone): mail changed. */
  mailChanged?: (accountId: string) => void;
  log?: (line: string) => void;
};

export interface OutboxWorker {
  start(signal: AbortSignal): Promise<void>;
  /** Runs a step now. The account id is informational: a step covers every account. */
  wake(accountId: string | null): void;
}

export function createOutboxWorker(
  deps: OutboxWorkerDeps,
  options: { intervalMs?: number; drainMs?: number; settleEveryMs?: number } = {},
): OutboxWorker {
  const intervalMs = options.intervalMs ?? OUTBOX_INTERVAL_MS;
  const drainMs = options.drainMs ?? DRAIN_MS;
  const settleEveryMs = options.settleEveryMs ?? SETTLE_EVERY_MS;
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop the worker.
    }
  };
  const ready = () => {
    try {
      return deps.isReady();
    } catch {
      return false;
    }
  };

  let woken = false;
  let cutSleep: (() => void) | null = null;
  let lastSettleAt: number | null = null;
  const failedCopyAt = new Map<string, number>();

  function wake(_accountId: string | null): void {
    woken = true;
    cutSleep?.();
  }

  async function step(stop: AbortSignal, sendSignal: AbortSignal): Promise<void> {
    if (!ready()) return;
    try {
      for (let n = 0; n < MAX_SENDS_PER_STEP && !stop.aborted; n++) {
        if (!(await runOutboxOnce(deps, sendSignal, stop))) break;
      }
    } catch (error) {
      log(`outbox: step failed (${kindOf(error)})`);
    }
    if (stop.aborted) return;
    await copyDrafts(stop);
    if (stop.aborted) return;
    const now = Date.now();
    if (lastSettleAt === null || now - lastSettleAt >= settleEveryMs) {
      lastSettleAt = now;
      try {
        const settled = await settleGmailUnknown(deps);
        if (settled > 0) log(`outbox: ${settled} unknown sends found in Sent`);
      } catch (error) {
        log(`outbox: settle failed (${kindOf(error)})`);
      }
    }
  }

  async function copyDrafts(stop: AbortSignal): Promise<void> {
    let accounts: string[];
    try {
      accounts = deps.store.listAccounts().map((account) => account.id);
    } catch {
      return;
    }
    const now = Date.now();
    for (const accountId of accounts) {
      let drafts;
      try {
        drafts = deps.store.listDrafts(accountId);
      } catch {
        continue;
      }
      for (const draft of drafts) {
        if (stop.aborted) return;
        // A hidden draft never gets a server copy (listDrafts returns it raw).
        if (isHiddenDraft(draft)) continue;
        if (draft.serverState === "local_only") continue;
        if (draft.serverCopy !== null && draft.serverCopy.revision >= draft.revision) continue;
        const failedAt = failedCopyAt.get(draft.id);
        if (failedAt !== undefined && now - failedAt < COPY_RETRY_MS) continue;
        const outcome = await writeServerCopy(deps, draft.id, "tick");
        if (outcome === "failed") failedCopyAt.set(draft.id, now);
        else failedCopyAt.delete(draft.id);
        if (outcome === "saved") deps.mailChanged?.(accountId);
      }
    }
  }

  async function start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const sendController = new AbortController();
    try {
      const recovered = deps.store.recoverOutboxOnStart(deps.clock.now().toISOString());
      if (recovered.unknown > 0 || recovered.held > 0) {
        log(`outbox: recovered ${recovered.unknown} unknown, ${recovered.held} held`);
      }
    } catch (error) {
      // Without recovery no row may be claimed: a `sending` row must never be resent.
      log(`outbox: recovery failed (${kindOf(error)})`);
      return;
    }

    let inFlight: Promise<void> | null = null;
    const loop = (async () => {
      while (!signal.aborted) {
        woken = false;
        inFlight = step(signal, sendController.signal);
        await inFlight;
        inFlight = null;
        if (signal.aborted || woken) continue;
        await sleep(intervalMs, signal);
      }
    })();

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    cutSleep?.();
    const current = inFlight as Promise<void> | null;
    if (current !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([current, new Promise<void>((resolve) => (timer = setTimeout(resolve, drainMs)))]);
      clearTimeout(timer);
    }
    sendController.abort();
    // The loop ends on its own; it must never reject past this point.
    void loop.catch(() => undefined);
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
      if (woken) done();
    });
  }

  return { start, wake };
}

function kindOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
