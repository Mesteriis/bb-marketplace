// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/imap/imapSync.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// One sync round for one account, INBOX only, over the core ports:
//   1. push reads the owner made in BB (the only server write: \Seen);
//   2. initial (window search, newest first) or incremental (uids after lastUid)
//      fetch in batches, each persisted with the sync state in one transaction;
//   3. reconcile the window: fetch what is missing locally (so an interrupted
//      initial sync resumes), delete what left the server, take server flags;
//   4. rebuild threads, record the result, notify.
// A UIDVALIDITY change detaches the folder's rows and resyncs it as initial;
// rows whose Message-ID reappears keep their ids. Never throws; error text is
// built from error classes and codes, so it never carries the password.
import type { FetchedMessage } from "./model.ts";
import {
  ImapAuthError,
  type ChangeNotifier,
  type Clock,
  type ImapGateway,
  type InboxSession,
  type MailStore,
  type SecretVault,
} from "./ports.ts";
import { buildThreads } from "./threading.ts";

export const INBOX = "INBOX";

const FLAG_BATCH_SIZE = 500;
const DAY_MS = 86_400_000;
const EPOCH_ISO = new Date(0).toISOString();

export interface SyncDeps {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  clock: Clock;
  notifier: ChangeNotifier;
}

export interface SyncOptions {
  windowDays: number;
  batchSize: number;
}

export type SyncOutcome =
  | { status: "ok"; fetched: number; removed: number; flagsChanged: number; pushedSeen: number }
  | { status: "error"; error: string; authFailed: boolean };

export async function syncAccount(
  deps: SyncDeps,
  accountId: string,
  options: SyncOptions,
): Promise<SyncOutcome> {
  const { store, gateway, vault, clock, notifier } = deps;
  const account = store.getAccount(accountId);
  if (!account) return { status: "error", error: "Account not found", authFailed: false };
  if (account.authFailed) {
    return {
      status: "error",
      error: account.lastError ?? describeError(new ImapAuthError()),
      authFailed: true,
    };
  }

  let password: string | null = null;
  try {
    password = vault.open(account.passwordSealed);
    const config = { host: account.host, port: account.port, user: account.username, password };
    const pushedSeen = await pushPendingSeen(deps, accountId, () =>
      gateway.openInbox(config, { readOnly: false }),
    );
    const session = await gateway.openInbox(config, { readOnly: true });
    let counts: { fetched: number; removed: number; flagsChanged: number };
    try {
      counts = await syncInbox(store, session, accountId, clock.now(), options);
    } finally {
      await closeQuietly(session);
    }
    store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)));
    store.recordSyncResult(accountId, {
      lastSyncAt: clock.now().toISOString(),
      lastError: null,
      authFailed: false,
    });
    notifier.mailChanged(accountId);
    return { status: "ok", ...counts, pushedSeen };
  } catch (error) {
    const authFailed = error instanceof ImapAuthError;
    const message = redact(describeError(error), password);
    store.recordSyncResult(accountId, {
      lastSyncAt: account.lastSyncAt,
      lastError: message,
      authFailed,
    });
    return { status: "error", error: message, authFailed };
  }
}

/**
 * Pushes reads the owner made in BB with a writable session. A failure keeps
 * the pending flags for the next round and does not stop the main sync.
 */
async function pushPendingSeen(
  deps: SyncDeps,
  accountId: string,
  openWritable: () => Promise<InboxSession>,
): Promise<number> {
  const uids = deps.store.pendingSeenUids(accountId, INBOX);
  if (uids.length === 0) return 0;
  let session: InboxSession | null = null;
  try {
    session = await openWritable();
    await session.markSeen(uids);
    deps.store.clearSeenPending(accountId, INBOX, uids);
    return uids.length;
  } catch {
    return 0;
  } finally {
    if (session) await closeQuietly(session);
  }
}

async function syncInbox(
  store: MailStore,
  session: InboxSession,
  accountId: string,
  now: Date,
  options: SyncOptions,
): Promise<{ fetched: number; removed: number; flagsChanged: number }> {
  const since = new Date(now.getTime() - options.windowDays * DAY_MS);
  const status = await session.status();
  const stored = store.getSyncState(accountId, INBOX);
  const resetting = stored !== null && stored.uidValidity !== status.uidValidity;
  if (resetting) store.beginFolderReset(accountId, INBOX);
  const initial = stored === null || resetting;

  const baseState = initial
    ? { uidValidity: status.uidValidity, lastUid: 0, syncedSince: since.toISOString() }
    : stored;
  const uids = initial
    ? (await session.searchSince(since)).sort((a, b) => b - a)
    : (await session.uidsAfter(stored.lastUid))
        .filter((uid) => uid > stored.lastUid)
        .sort((a, b) => a - b);

  let lastUid = baseState.lastUid;
  /** Fetches uids in batches; each batch is stored with the sync state in one transaction. */
  const fetchAndStore = async (batchUids: number[]): Promise<number> => {
    let count = 0;
    for (let i = 0; i < batchUids.length; i += options.batchSize) {
      const messages: FetchedMessage[] = await session.fetchMessages(
        batchUids.slice(i, i + options.batchSize),
      );
      for (const message of messages) lastUid = Math.max(lastUid, message.uid);
      count += messages.length;
      store.transaction(() => {
        store.upsertMessages(accountId, INBOX, messages);
        store.saveSyncState(accountId, INBOX, { ...baseState, lastUid });
      });
    }
    return count;
  };

  let fetched = await fetchAndStore(uids);
  if (initial && uids.length === 0) {
    // Nothing in the window: start incremental sync from the current end of
    // the mailbox rather than from uid 0, which would pull in old mail.
    lastUid = Math.max(0, status.uidNext - 1);
    store.saveSyncState(accountId, INBOX, { ...baseState, lastUid });
  }

  const reconciled = await reconcile(store, session, accountId, since, fetchAndStore);
  fetched += reconciled.backfilled;
  const resetRemoved = resetting ? store.finishFolderReset(accountId, INBOX) : 0;
  return {
    fetched,
    removed: reconciled.removed + resetRemoved,
    flagsChanged: reconciled.flagsChanged,
  };
}

/**
 * Brings the window in line with the server: fetches window messages missing
 * locally (an interrupted initial sync resumes here), deletes local messages
 * gone from the server, and takes the server's flags.
 */
async function reconcile(
  store: MailStore,
  session: InboxSession,
  accountId: string,
  since: Date,
  fetchAndStore: (uids: number[]) => Promise<number>,
): Promise<{ backfilled: number; removed: number; flagsChanged: number }> {
  const serverUids = await session.searchSince(since);
  const onServer = new Set(serverUids);
  // Every stored uid, not only the window's: a message whose stored date falls
  // outside the window but whose server date is inside it is already here.
  const stored = new Set(
    store.localFolderIndex(accountId, INBOX, EPOCH_ISO).map((entry) => entry.uid),
  );
  const missing = serverUids.filter((uid) => !stored.has(uid)).sort((a, b) => b - a);
  const backfilled = await fetchAndStore(missing);

  const local = store.localFolderIndex(accountId, INBOX, since.toISOString());
  const gone = local.filter((entry) => !onServer.has(entry.uid)).map((entry) => entry.uid);
  const present = local.filter((entry) => onServer.has(entry.uid)).map((entry) => entry.uid);

  const removed = gone.length > 0 ? store.deleteByUids(accountId, INBOX, gone) : 0;
  let flagsChanged = 0;
  for (let i = 0; i < present.length; i += FLAG_BATCH_SIZE) {
    const flags = await session.fetchFlags(present.slice(i, i + FLAG_BATCH_SIZE));
    flagsChanged += store.applyFlags(accountId, INBOX, flags);
  }
  return { backfilled, removed, flagsChanged };
}

async function closeQuietly(session: InboxSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // The round's outcome is already decided; a failed logout changes nothing.
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Describes an error by its class and code only; messages may echo credentials. */
function describeError(error: unknown): string {
  if (error instanceof ImapAuthError) return "Authentication failed";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SAFE_CODE.test(code)) return `Sync failed (${code})`;
  const name = error instanceof Error ? error.name : "";
  if (SAFE_NAME.test(name) && name !== "Error") return `Sync failed (${name})`;
  return "Sync failed";
}

/** Defence in depth: the description never echoes messages, but strip the password anyway. */
function redact(text: string, password: string | null): string {
  return password ? text.split(password).join("***") : text;
}
