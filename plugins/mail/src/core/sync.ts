// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/imap/imapSync.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// One sync round for one account, every selectable folder, over the core ports:
//   1. list the server's folders (one session-less call) and save them; folders
//      gone from the server are dropped locally with their rows;
//   2. per selectable folder, in store order: when it has pending flag
//      changes or moves, push them on a writable session after the
//      UIDVALIDITY check: the owner's \Seen / \Flagged intents first (one
//      STORE per set: seen+, seen-, flag+, flag-), then the owner's moves
//      grouped by destination (the only server writes);
//   3. then the read-only folder sync: initial (window search, newest first) or
//      incremental (uids after lastUid) fetch in batches, each persisted with
//      the folder's sync state in one transaction; reconcile the window: fetch
//      what is missing locally (so an interrupted initial sync resumes), delete
//      what left the server, take server flags;
//   4. rebuild threads once, record the result, notify.
// A UIDVALIDITY change detaches the folder's rows and resyncs it as initial;
// rows whose Message-ID reappears keep their ids; rows still detached after a
// successful round are deleted. A completed move re-homes rows in the store,
// so the destination's own sync neither refetches nor deletes them; without a
// uid map they are detached there and reattached by that folder's sync (in
// this round when the destination comes later in the folder order, else in
// the next). One failing folder is recorded and the round goes on; a rejected
// login stops the account. Never throws; error text is built from error
// classes and codes, so it never carries the password.
import type { FetchedMessage, FlagChange, FlagIntent, Folder, RemoteFolder } from "./model.ts";
import {
  ImapAuthError,
  type ChangeNotifier,
  type Clock,
  type ImapConfig,
  type ImapGateway,
  type FolderSession,
  type MailStore,
  type SecretVault,
} from "./ports.ts";
import { buildThreads } from "./threading.ts";

export const INBOX = "INBOX";

const FLAG_BATCH_SIZE = 500;
const DAY_MS = 86_400_000;
const EPOCH_ISO = new Date(0).toISOString();
/** Gateway error codes for moves (see FolderSession.moveMessages). */
const MOVE_REFUSED = "MoveFailed";
const MOVE_UNSUPPORTED = "MoveUnsupported";
/** Gateway error code for a refused STORE (see FolderSession.setFlags). */
const STORE_REFUSED = "StoreFailed";

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
  | {
      status: "ok";
      fetched: number;
      removed: number;
      flagsChanged: number;
      /** Messages marked read on the server (\Seen added). */
      pushedSeen: number;
      /** Other flag changes pushed: \Seen removed, \Flagged added or removed. */
      pushedFlags: number;
      /** Selectable folders synced successfully this round. */
      folders: number;
      /** Ids of messages whose move was cancelled this round (they stay put). */
      movesCancelled: string[];
    }
  | {
      status: "error";
      error: string;
      authFailed: boolean;
      /** Present when the round cancelled moves before it failed. */
      movesCancelled?: string[];
    };

type FolderCounts = { fetched: number; removed: number; flagsChanged: number };

/** What a round has done so far, kept across folders and failures. */
type RoundProgress = {
  pushedSeen: number;
  pushedFlags: number;
  movesCancelled: string[];
  /** Local rows changed (moves completed or cancelled, folders synced). */
  changed: boolean;
  /** Text for lastError: cancelled moves and failed folders. */
  problems: string[];
  /** Strips the password from error text (defence in depth). */
  describe: (error: unknown) => string;
};

/** An account-level failure whose message is fixed text, safe to show. */
class SyncRoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRoundError";
  }
}

/**
 * A store call in the push failed. Unlike a gateway error it must fail the
 * folder: the server may already have moved the mail.
 */
class StoreFailure extends Error {
  constructor(readonly original: unknown) {
    super("store failure");
    this.name = "StoreFailure";
  }
}

function local<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new StoreFailure(error);
  }
}

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
  const progress: RoundProgress = {
    pushedSeen: 0,
    pushedFlags: 0,
    movesCancelled: [],
    changed: false,
    problems: [],
    describe: (error) => redact(describeError(error), password),
  };
  try {
    password = vault.open(account.passwordSealed);
    const config = { host: account.host, port: account.port, user: account.username, password };
    saveListing(store, accountId, await gateway.listFolders(config), progress);
    const folders = store.listFolders(accountId).filter((folder) => folder.selectable);

    const totals: FolderCounts = { fetched: 0, removed: 0, flagsChanged: 0 };
    let synced = 0;
    for (const folder of folders) {
      try {
        const counts = await syncOneFolder(deps, config, accountId, folder, options, progress);
        totals.fetched += counts.fetched;
        totals.removed += counts.removed;
        totals.flagsChanged += counts.flagsChanged;
        synced++;
        progress.changed = true;
      } catch (error) {
        if (error instanceof ImapAuthError) throw error;
        const cause = error instanceof StoreFailure ? error.original : error;
        progress.problems.push(`${folder.name}: ${progress.describe(cause)}`);
      }
    }

    store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)));
    const lastError = problemText(progress);
    if (folders.length > 0 && synced === 0) {
      // Every folder failed: like a failed slice-1 round, lastSyncAt stays.
      const error = lastError ?? describeError(null);
      store.recordSyncResult(accountId, {
        lastSyncAt: account.lastSyncAt,
        lastError: error,
        authFailed: false,
      });
      if (progress.changed) notifier.mailChanged(accountId);
      return {
        status: "error",
        error,
        authFailed: false,
        ...cancelledField(progress),
      };
    }
    store.recordSyncResult(accountId, {
      lastSyncAt: clock.now().toISOString(),
      lastError,
      authFailed: false,
    });
    notifier.mailChanged(accountId);
    return {
      status: "ok",
      ...totals,
      pushedSeen: progress.pushedSeen,
      pushedFlags: progress.pushedFlags,
      folders: synced,
      movesCancelled: progress.movesCancelled,
    };
  } catch (error) {
    const authFailed = error instanceof ImapAuthError;
    const message = redact(describeError(error), password);
    try {
      if (progress.changed) {
        store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)));
      }
      store.recordSyncResult(accountId, {
        lastSyncAt: account.lastSyncAt,
        lastError: [message, problemText(progress)].filter((t) => t !== null).join("; "),
        authFailed,
      });
      if (progress.changed) notifier.mailChanged(accountId);
    } catch {
      // The outcome still carries the error; the next round records it again.
    }
    return { status: "error", error: message, authFailed, ...cancelledField(progress) };
  }
}

/** The round's problems, each once, in the order they happened. */
function problemText(progress: RoundProgress): string | null {
  const unique = [...new Set(progress.problems)];
  return unique.length > 0 ? unique.join("; ") : null;
}

/**
 * Saves the server's folder listing. A listing without a selectable INBOX is
 * taken as a broken answer, not as every folder being deleted: nothing is
 * saved and the round fails. Moves still queued in a folder the listing drops
 * go with its rows and are reported as cancelled.
 */
function saveListing(
  store: MailStore,
  accountId: string,
  listing: RemoteFolder[],
  progress: RoundProgress,
): void {
  const hasInbox = listing.some(
    (f) => f.selectable && (f.path.toUpperCase() === INBOX || f.specialUse === "inbox"),
  );
  if (!hasInbox) throw new SyncRoundError("Folder list from the server is missing INBOX");
  const listed = new Set(listing.map((f) => f.path));
  const doomed = store
    .listFolders(accountId)
    .filter((f) => !listed.has(f.path))
    .map((f) => ({ name: f.name, ids: store.pendingMoves(accountId, f.path).map((m) => m.id) }))
    .filter((f) => f.ids.length > 0);
  store.saveFolders(accountId, listing);
  for (const folder of doomed) {
    progress.movesCancelled.push(...folder.ids);
    progress.problems.push(
      `${folder.name} no longer exists; ${folder.ids.length} queued move(s) were dropped`,
    );
  }
}

function cancelledField(progress: RoundProgress): { movesCancelled?: string[] } {
  return progress.movesCancelled.length > 0 ? { movesCancelled: progress.movesCancelled } : {};
}

/** Pushes the folder's pending writes, then syncs it read-only. */
async function syncOneFolder(
  deps: SyncDeps,
  config: ImapConfig,
  accountId: string,
  folder: Folder,
  options: SyncOptions,
  progress: RoundProgress,
): Promise<FolderCounts> {
  await pushPending(deps, accountId, folder, progress, () =>
    deps.gateway.openFolder(config, folder.path, { readOnly: false }),
  );
  const session = await deps.gateway.openFolder(config, folder.path, { readOnly: true });
  try {
    const counts = await syncFolder(
      deps.store,
      session,
      accountId,
      folder.path,
      deps.clock.now(),
      options,
    );
    if (counts.droppedMoves.length > 0) {
      progress.changed = true;
      progress.movesCancelled.push(...counts.droppedMoves);
      progress.problems.push(
        `${folder.name} was renumbered by the server; ${counts.droppedMoves.length} queued move(s) were dropped`,
      );
    }
    return counts;
  } finally {
    await closeQuietly(session);
  }
}

/**
 * Pushes what the owner did in BB with a writable session: flag changes, then
 * moves. The push is skipped while the stored UIDVALIDITY does not match the
 * server's: the pending uids would name other messages. Pending flag changes
 * and moves stay on their rows and are pushed with the new uids once the
 * folder is resynced. A refused STORE keeps its changes pending and the push
 * goes on (see pushFlags); any other gateway failure ends the push with
 * what is not yet pushed left pending, is recorded as a problem of the folder
 * and lets the folder sync run; a store failure fails the folder (the server may
 * already hold the change); an ImapAuthError is rethrown so the round stops
 * without another login.
 */
async function pushPending(
  deps: SyncDeps,
  accountId: string,
  folder: Folder,
  progress: RoundProgress,
  openWritable: () => Promise<FolderSession>,
): Promise<void> {
  const { store } = deps;
  const path = folder.path;
  const intents = store.pendingFlagIntents(accountId, path);
  const moves = store.pendingMoves(accountId, path);
  if (intents.length === 0 && moves.length === 0) return;
  const stored = store.getSyncState(accountId, path);
  if (stored === null) return;
  const gatewayFailed = (error: unknown) => {
    if (error instanceof ImapAuthError || error instanceof StoreFailure) throw error;
    progress.problems.push(`${folder.name}: ${progress.describe(error)}`);
  };
  let session: FolderSession | null = null;
  try {
    session = await openWritable();
    const status = await session.status();
    if (status.uidValidity !== stored.uidValidity) return;
    if (intents.length > 0) await pushFlags(store, session, accountId, folder, intents, progress);
    if (moves.length > 0) await pushMoves(store, session, accountId, folder, moves, progress);
  } catch (error) {
    gatewayFailed(error);
  } finally {
    if (session) await closeQuietly(session);
  }
}

/** The four STORE sets, in push order, and how each reads an intent. */
const FLAG_SETS: {
  change: FlagChange;
  wants: (intent: FlagIntent) => boolean;
  pushed: (uid: number) => FlagIntent;
}[] = [
  {
    change: { seen: true },
    wants: (i) => i.seen === true,
    pushed: (uid) => ({ uid, seen: true, flagged: null }),
  },
  {
    change: { seen: false },
    wants: (i) => i.seen === false,
    pushed: (uid) => ({ uid, seen: false, flagged: null }),
  },
  {
    change: { flagged: true },
    wants: (i) => i.flagged === true,
    pushed: (uid) => ({ uid, seen: null, flagged: true }),
  },
  {
    change: { flagged: false },
    wants: (i) => i.flagged === false,
    pushed: (uid) => ({ uid, seen: null, flagged: false }),
  },
];

/**
 * Pushes the owner's flag changes, one STORE per non-empty set. After each
 * STORE the store clears exactly what it pushed, compare-and-clear: a click
 * made while the STORE was in flight stays pending for the next round. A
 * refused STORE keeps its changes pending (a moved row carries them to its
 * destination), adds a problem line and lets the other sets and the moves
 * run; retrying is harmless, so nothing is counted. Any other gateway error
 * is thrown and ends the push.
 */
async function pushFlags(
  store: MailStore,
  session: FolderSession,
  accountId: string,
  folder: Folder,
  intents: FlagIntent[],
  progress: RoundProgress,
): Promise<void> {
  for (const set of FLAG_SETS) {
    const uids = intents.filter(set.wants).map((intent) => intent.uid);
    if (uids.length === 0) continue;
    try {
      await session.setFlags(uids, set.change);
    } catch (error) {
      if (errorCode(error) !== STORE_REFUSED) throw error;
      progress.problems.push(`${folder.name}: could not update flags on the server`);
      continue;
    }
    local(() => store.clearFlagIntents(accountId, folder.path, uids.map(set.pushed)));
    if (set.change.seen === true) progress.pushedSeen += uids.length;
    else progress.pushedFlags += uids.length;
  }
}

/**
 * Moves pending rows, one server call per destination. A refusal counts
 * toward the store's cancel limit; a server that cannot move safely cancels
 * the move at once; any other gateway error (a dropped connection) leaves
 * every remaining move pending, uncounted, and ends the push.
 */
async function pushMoves(
  store: MailStore,
  session: FolderSession,
  accountId: string,
  folder: Folder,
  moves: { uid: number; id: string; destination: string }[],
  progress: RoundProgress,
): Promise<void> {
  const byDestination = new Map<string, { uid: number; id: string }[]>();
  for (const move of moves) {
    const group = byDestination.get(move.destination);
    if (group) group.push(move);
    else byDestination.set(move.destination, [move]);
  }
  const cancelled: string[] = [];
  try {
    for (const [destination, group] of byDestination) {
      const uids = group.map((entry) => entry.uid);
      let moved: Map<number, number> | null;
      try {
        ({ moved } = await session.moveMessages(uids, destination));
      } catch (error) {
        const code = errorCode(error);
        if (code === MOVE_REFUSED) {
          cancelled.push(...local(() => store.failMove(accountId, folder.path, uids)).cancelled);
          continue;
        }
        if (code === MOVE_UNSUPPORTED) {
          // Nothing reached the server. A uid map without these uids settles
          // the rows where they are: move_pending cleared, no failure counted.
          local(() => store.completeMove(accountId, folder.path, destination, new Map(), uids));
          cancelled.push(...group.map((entry) => entry.id));
          continue;
        }
        throw error;
      }
      local(() => store.completeMove(accountId, folder.path, destination, moved, uids));
      progress.changed = true;
    }
  } finally {
    if (cancelled.length > 0) {
      progress.changed = true;
      progress.movesCancelled.push(...cancelled);
      progress.problems.push(
        `Could not move ${cancelled.length} message(s); they were returned to ${folder.name}`,
      );
    }
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

async function syncFolder(
  store: MailStore,
  session: FolderSession,
  accountId: string,
  path: string,
  now: Date,
  options: SyncOptions,
): Promise<FolderCounts & { droppedMoves: string[] }> {
  const since = new Date(now.getTime() - options.windowDays * DAY_MS);
  const status = await session.status();
  const stored = store.getSyncState(accountId, path);
  // A folder never synced may already hold rows (re-homed by a move): their
  // uids are unchecked against this UIDVALIDITY, so it starts as a reset too,
  // or a reused uid would hide a new message behind a stale row.
  const resetting =
    stored === null
      ? store.localFolderIndex(accountId, path, EPOCH_ISO).length > 0
      : stored.uidValidity !== status.uidValidity;
  // Moves still queued here when the reset starts; any whose row the reset
  // deletes (not reattached, outside the window) is reported as dropped.
  const queuedAtReset = resetting ? store.pendingMoves(accountId, path).map((m) => m.id) : [];
  if (resetting) store.beginFolderReset(accountId, path);
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
  /**
   * Fetches uids in batches; each batch is stored with the sync state in one
   * transaction. lastUid covers every requested uid, fetched or not: one the
   * server no longer returns was expunged, and a window message missed by an
   * interrupted round is backfilled by reconcile whatever lastUid says.
   */
  const fetchAndStore = async (batchUids: number[]): Promise<number> => {
    let count = 0;
    for (let i = 0; i < batchUids.length; i += options.batchSize) {
      const batch = batchUids.slice(i, i + options.batchSize);
      const messages: FetchedMessage[] = await session.fetchMessages(batch);
      for (const uid of batch) lastUid = Math.max(lastUid, uid);
      for (const message of messages) lastUid = Math.max(lastUid, message.uid);
      count += messages.length;
      store.transaction(() => {
        store.upsertMessages(accountId, path, messages);
        store.saveSyncState(accountId, path, { ...baseState, lastUid });
      });
    }
    return count;
  };

  // A uid already stored here is a message a completed move re-homed into this
  // folder with its new uid: it is not fetched again, but lastUid covers it.
  const known = new Set(store.localFolderIndex(accountId, path, EPOCH_ISO).map((e) => e.uid));
  let fetched = await fetchAndStore(uids.filter((uid) => !known.has(uid)));
  const highest = uids.reduce((max, uid) => Math.max(max, uid), lastUid);
  if (highest > lastUid) {
    lastUid = highest;
    store.saveSyncState(accountId, path, { ...baseState, lastUid });
  }
  const reconciled = await reconcile(store, session, accountId, path, since, fetchAndStore);
  fetched += reconciled.backfilled;
  if (initial) {
    // The window is stored: start incremental sync from the end of the
    // mailbox, never from a lower uid, which would pull in old mail. Saved
    // even for an empty window, so the next round is incremental.
    lastUid = Math.max(lastUid, status.uidNext - 1);
    store.saveSyncState(accountId, path, { ...baseState, lastUid });
  }
  // Every successful round, not only the one that saw the change: a reset
  // round that failed midway has already saved the new UIDVALIDITY, so the
  // rows it detached are only cleaned up here.
  const stillThere = queuedAtReset.filter((id) => store.getMessage(id) !== null);
  const resetRemoved = store.finishFolderReset(accountId, path);
  const droppedMoves = stillThere.filter((id) => store.getMessage(id) === null);
  return {
    droppedMoves,
    fetched,
    removed: reconciled.removed + resetRemoved,
    flagsChanged: reconciled.flagsChanged,
  };
}

/**
 * Brings the window in line with the server: fetches window messages missing
 * locally (an interrupted initial sync resumes here), deletes local messages
 * gone from the server, and takes the server's flags.
 *
 * SEARCH SINCE matches the server's INTERNALDATE while the local window is
 * cut by the header date, so absence from the search alone never deletes: a
 * local window message is deleted only when a UID FETCH of its flags returns
 * nothing for it.
 */
async function reconcile(
  store: MailStore,
  session: FolderSession,
  accountId: string,
  path: string,
  since: Date,
  fetchAndStore: (uids: number[]) => Promise<number>,
): Promise<{ backfilled: number; removed: number; flagsChanged: number }> {
  const serverUids = await session.searchSince(since);
  // Every stored uid, not only the window's: a message whose stored date falls
  // outside the window but whose server date is inside it is already here.
  const stored = new Set(
    store.localFolderIndex(accountId, path, EPOCH_ISO).map((entry) => entry.uid),
  );
  const missing = serverUids.filter((uid) => !stored.has(uid)).sort((a, b) => b - a);
  const backfilled = await fetchAndStore(missing);

  // Includes the messages just backfilled, whose flags are already current.
  const local = store
    .localFolderIndex(accountId, path, since.toISOString())
    .map((entry) => entry.uid);
  const onServer = new Set<number>();
  let flagsChanged = 0;
  for (let i = 0; i < local.length; i += FLAG_BATCH_SIZE) {
    const flags = await session.fetchFlags(local.slice(i, i + FLAG_BATCH_SIZE));
    for (const entry of flags) onServer.add(entry.uid);
    flagsChanged += store.applyFlags(accountId, path, flags);
  }
  // Every flag batch succeeded (a failure throws and ends the round), so a uid
  // the server returned nothing for is gone from it.
  const gone = local.filter((uid) => !onServer.has(uid));
  const removed = gone.length > 0 ? store.deleteByUids(accountId, path, gone) : 0;
  return { backfilled, removed, flagsChanged };
}

async function closeQuietly(session: FolderSession): Promise<void> {
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
  if (error instanceof SyncRoundError) return error.message;
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
