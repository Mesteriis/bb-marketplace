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
//
// Slice 3h: rows loaded by a history or server-search job carry `kept`
// (KeptState). Reconcile clears it on rows inside the window (they are
// window rows again) and, with `historyCheck`, once a day per folder also
// checks the flags of loaded history (between history_since and the
// window), deleting what left the server. A reset also looks for `opened`
// rows and clears history_since. Gmail sessions report X-GM-LABELS, which
// are stored at every fetch and refreshed in the flag pass.
import type { AccountPreset, FetchedMessage, FlagChange, FlagIntent, Folder, RemoteFolder, SpecialUse } from "./model.ts";
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
import { normalizeMessageId } from "./headers.ts";
import { SNOOZES_MAX_PER_ACCOUNT } from "./snooze.ts";
import { buildThreads } from "./threading.ts";
import { unsubscribeInfoOf } from "./unsubscribe.ts";
import { classifyDev, normalizeListId } from "./dev-notify.ts";
import { cryptoKindOf, firstNonBlankLine, isEncrypted } from "./mail-crypto.ts";
import { senderCheckOf } from "./sender-check.ts";

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
  /**
   * "inbox": an Inbox-only round (slice 3e, woken by IDLE): no listing, only
   * the stored Inbox-role folder is pushed and synced, `lastSyncAt` is kept
   * and the full round's `lastError` is kept with this round's problems
   * appended. Absent: a full round.
   */
  only?: "inbox";
  /**
   * Slice 3g: classify new rows as dev notifications (the devNotifications
   * setting); Spam and Trash rows are never classified. Absent: off.
   */
  classify?: boolean;
  /** Hosts of the BB projects' remotes: a self-hosted GitLab or Jenkins sender counts only from these (or with its own List-Id). */
  devHosts?: readonly string[];
  /**
   * Slice 3h (spec resolution 9): reconcile also checks the flags of the
   * loaded history of a folder whose last check is missing or older than
   * HISTORY_CHECK_EVERY_MS. The sync service sets it on full rounds.
   */
  historyCheck?: boolean;
}

/** Loaded history of a folder is checked against the server at most this often. */
export const HISTORY_CHECK_EVERY_MS = 86_400_000;

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
      /**
       * Rows inserted into an Inbox-role folder by this round's incremental
       * fetch (not an initial sync, a reset or a reconcile backfill), not
       * reattached or re-homed (slice 3e).
       */
      newInbox: string[];
      /** The `newInbox` rows whose dedup key already had another row in the account. */
      returning: string[];
      /** Rows inserted this round in every folder, reconcile backfill included (slice 3f: reply reminders check them). */
      inserted: string[];
    }
  | {
      status: "error";
      error: string;
      authFailed: boolean;
      /** Present when the round cancelled moves before it failed. */
      movesCancelled?: string[];
    };

type FolderCounts = { fetched: number; removed: number; flagsChanged: number };

/** How a fetched message is judged before it is stored (sync, and slice 3h jobs). */
export type PrepareContext = {
  preset: AccountPreset;
  /** Slice 3g: classification is on and the folder is not Spam or Trash. */
  classifyDev: boolean;
  /** The project remotes' hosts the classifier vouches for. */
  devHosts: ReadonlySet<string>;
  /**
   * Slice 3i: the role of the folder being judged (not a `Folder`'s own
   * field): Sent and Drafts copies are not sender-checked (resolution 3).
   */
  folderRole: SpecialUse | null;
};

/** What one folder's sync needs beyond the session: how to judge headers, and where new Inbox rows go. */
type FolderContext = PrepareContext & {
  /** Set for an Inbox-role folder: its incremental fetch collects inserted rows here. */
  collect: { newInbox: string[]; returning: string[] } | null;
  /** Every row inserted this round in any folder, reconcile backfill included (slice 3f). */
  inserted: string[];
};

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

  const inboxOnly = options.only === "inbox";
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
    // An Inbox-only round (IDLE) lists nothing: the stored listing stands.
    if (!inboxOnly) {
      saveListing(store, accountId, account.snoozeFolder, await gateway.listFolders(config), progress);
    }
    const folders = store
      .listFolders(accountId)
      .filter((folder) => folder.selectable && (!inboxOnly || folder.specialUse === "inbox"));

    const totals: FolderCounts = { fetched: 0, removed: 0, flagsChanged: 0 };
    const collected = { newInbox: [] as string[], returning: [] as string[] };
    const inserted: string[] = [];
    let synced = 0;
    for (const folder of folders) {
      try {
        const context: FolderContext = {
          preset: account.preset,
          classifyDev: options.classify === true && folder.specialUse !== "junk" && folder.specialUse !== "trash",
          devHosts: new Set((options.devHosts ?? []).map((host) => host.toLowerCase())),
          folderRole: folder.specialUse,
          collect: folder.specialUse === "inbox" ? collected : null,
          inserted,
        };
        const counts = await syncOneFolder(deps, config, accountId, folder, options, progress, context);
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
        lastError: inboxOnly ? mergeErrors(account.lastError, progress.problems.length > 0 ? progress.problems : [error]) : error,
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
    // An Inbox-only round keeps the full round's time and its lastError,
    // adding its own problems (spec resolution 16).
    store.recordSyncResult(accountId, {
      lastSyncAt: inboxOnly ? account.lastSyncAt : clock.now().toISOString(),
      lastError: inboxOnly ? mergeErrors(account.lastError, progress.problems) : lastError,
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
      newInbox: collected.newInbox,
      returning: collected.returning,
      inserted,
    };
  } catch (error) {
    const authFailed = error instanceof ImapAuthError;
    const message = redact(describeError(error), password);
    try {
      if (progress.changed) {
        store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)));
      }
      const roundError = [message, problemText(progress)].filter((t) => t !== null).join("; ");
      store.recordSyncResult(accountId, {
        lastSyncAt: account.lastSyncAt,
        lastError: inboxOnly && !authFailed ? mergeErrors(account.lastError, [message, ...progress.problems]) : roundError,
        authFailed,
      });
      if (progress.changed) notifier.mailChanged(accountId);
    } catch {
      // The outcome still carries the error; the next round records it again.
    }
    return { status: "error", error: message, authFailed, ...cancelledField(progress) };
  }
}

/**
 * The stored lastError with `problems` appended, each part once; never
 * cleared (an Inbox-only round does not see the other folders).
 */
function mergeErrors(stored: string | null, problems: string[]): string | null {
  const parts = stored === null || stored === "" ? [] : stored.split("; ");
  for (const problem of problems) if (!parts.includes(problem)) parts.push(problem);
  return parts.length > 0 ? parts.join("; ") : null;
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
 * go with its rows and are reported as cancelled. A snooze folder the listing
 * no longer has (renamed or deleted elsewhere) is cleared, so the next snooze
 * asks again (spec resolution 18).
 */
function saveListing(
  store: MailStore,
  accountId: string,
  snoozeFolder: string | null,
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
  if (snoozeFolder !== null && !listing.some((f) => f.path === snoozeFolder && f.selectable)) {
    store.setSnoozeFolder(accountId, null);
  }
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
  context: FolderContext,
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
      context,
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
  context: FolderContext,
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
  // Rows a first sync or a reset must not lose to the window (review item
  // 1): every row of a never-synced folder (a move re-homed it here), a row
  // with a live snooze, and a row with a queued move. They are looked for by
  // uid and Message-ID before the reset deletes what is still detached.
  const kept =
    stored === null || resetting
      ? keptAtReset(store, accountId, path, stored === null, queuedAtReset)
      : new Map<string, number | null>();
  if (resetting) {
    store.beginFolderReset(accountId, path);
    // Loaded history named the old uids: "Load 30 more days" starts again.
    store.setHistorySince(accountId, path, null);
  }
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
  const fetchAndStore = async (
    batchUids: number[],
    collect: FolderContext["collect"] = null,
  ): Promise<number> => {
    let count = 0;
    for (let i = 0; i < batchUids.length; i += options.batchSize) {
      const batch = batchUids.slice(i, i + options.batchSize);
      const messages: FetchedMessage[] = (await session.fetchMessages(batch)).map((message) =>
        prepareMessage(message, context),
      );
      for (const uid of batch) lastUid = Math.max(lastUid, uid);
      for (const message of messages) lastUid = Math.max(lastUid, message.uid);
      count += messages.length;
      const stored = store.transaction(() => {
        const result = store.upsertMessages(accountId, path, messages);
        storeLabels(store, accountId, path, messages.map((m) => ({ uid: m.uid, labels: m.gmLabels })));
        store.saveSyncState(accountId, path, { ...baseState, lastUid });
        return result;
      });
      context.inserted.push(...stored.inserted);
      if (collect !== null) {
        collect.newInbox.push(...stored.inserted);
        collect.returning.push(...stored.returning);
      }
    }
    return count;
  };

  // A uid already stored here is a message a completed move re-homed into this
  // folder with its new uid: it is not fetched again, but lastUid covers it.
  // Only this incremental fetch of an Inbox folder collects new mail: never
  // an initial sync, a reset or reconcile's backfill (spec resolution 16).
  const known = new Set(store.localFolderIndex(accountId, path, EPOCH_ISO).map((e) => e.uid));
  let fetched = await fetchAndStore(
    uids.filter((uid) => !known.has(uid)),
    initial ? null : context.collect,
  );
  const highest = uids.reduce((max, uid) => Math.max(max, uid), lastUid);
  if (highest > lastUid) {
    lastUid = highest;
    store.saveSyncState(accountId, path, { ...baseState, lastUid });
  }
  const historyFrom = initial || options.historyCheck !== true ? null : historyDue(store, accountId, path, now);
  const reconciled = await reconcile(store, session, accountId, path, since, fetchAndStore, historyFrom);
  if (historyFrom !== null) store.historyChecked(accountId, path, now.toISOString());
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
  if (kept.size > 0) fetched += await reattachKept(store, session, accountId, path, kept, context, options.batchSize, context.inserted);
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
 * The rows a first sync or a reset keeps looking for, by id with the uid
 * they had (null: already detached; review item 1): all of a never-synced
 * folder's rows, rows with a live snooze and rows with a queued move.
 */
function keptAtReset(
  store: MailStore,
  accountId: string,
  path: string,
  neverSynced: boolean,
  queued: readonly string[],
): Map<string, number | null> {
  const wanted = new Set<string>(queued);
  for (const snooze of store.listSnoozes(accountId, { limit: SNOOZES_MAX_PER_ACCOUNT })) wanted.add(snooze.messageId);
  // Slice 3h (spec resolution 16): a row the owner touched is never lost only because of the reset.
  for (const id of store.keptIds(accountId, path, "opened")) wanted.add(id);
  const kept = new Map<string, number | null>();
  for (const row of store.detachedRows(accountId, path)) if (neverSynced || wanted.has(row.id)) kept.set(row.id, null);
  for (const entry of store.localFolderIndex(accountId, path, EPOCH_ISO)) {
    if (neverSynced || wanted.has(entry.id)) kept.set(entry.id, entry.uid);
  }
  return kept;
}

/**
 * After a reset's window fetch: the kept rows still detached are looked for
 * on the server, first at the uid they had, then by Message-ID, and
 * reattached when the message found is theirs (same Gmail id or Message-ID).
 * A row found nowhere stays detached and the reset deletes it. Returns how
 * many messages were stored.
 */
async function reattachKept(
  store: MailStore,
  session: FolderSession,
  accountId: string,
  path: string,
  kept: ReadonlyMap<string, number | null>,
  context: PrepareContext,
  batchSize: number,
  inserted: string[],
): Promise<number> {
  const detached = () => store.detachedRows(accountId, path).filter((row) => kept.has(row.id));
  const ours = (message: FetchedMessage, rows: ReturnType<typeof detached>) =>
    rows.some(
      (row) =>
        (row.gmMsgId !== null && message.gmMsgId === row.gmMsgId) ||
        (row.messageId !== null && message.messageId !== null &&
          normalizeMessageId(message.messageId) === normalizeMessageId(row.messageId)),
    );
  let stored = 0;
  const attach = async (uids: number[]) => {
    const attached = new Set(store.localFolderIndex(accountId, path, EPOCH_ISO).map((entry) => entry.uid));
    const fresh = [...new Set(uids)].filter((uid) => !attached.has(uid));
    for (let i = 0; i < fresh.length; i += batchSize) {
      const rows = detached();
      if (rows.length === 0) return;
      const messages = (await session.fetchMessages(fresh.slice(i, i + batchSize)))
        .filter((message) => ours(message, rows))
        .map((message) => prepareMessage(message, context));
      if (messages.length === 0) continue;
      inserted.push(
        ...store.transaction(() => {
          const result = store.upsertMessages(accountId, path, messages);
          storeLabels(store, accountId, path, messages.map((m) => ({ uid: m.uid, labels: m.gmLabels })));
          return result;
        }).inserted,
      );
      stored += messages.length;
    }
  };
  await attach(detached().flatMap((row) => {
    const uid = kept.get(row.id);
    return uid === null || uid === undefined ? [] : [uid];
  }));
  const byMessageId: number[] = [];
  for (const row of detached()) {
    if (row.messageId !== null) byMessageId.push(...(await session.findByMessageId(row.messageId)));
  }
  await attach(byMessageId);
  return stored;
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
  /** Slice 3h: also check loaded history from this date up to the window (null: the window only). */
  historyFrom: string | null,
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
  // Slice 3h: loaded history between historyFrom and the window, checked the same way.
  const windowUids = new Set(local);
  const history =
    historyFrom === null
      ? []
      : store
          .localFolderIndex(accountId, path, historyFrom)
          .map((entry) => entry.uid)
          .filter((uid) => !windowUids.has(uid));
  const checked = [...local, ...history];
  for (let i = 0; i < checked.length; i += FLAG_BATCH_SIZE) {
    const flags = await session.fetchFlags(checked.slice(i, i + FLAG_BATCH_SIZE));
    for (const entry of flags) onServer.add(entry.uid);
    flagsChanged += store.applyFlags(accountId, path, flags);
    storeLabels(store, accountId, path, flags.map((entry) => ({ uid: entry.uid, labels: entry.labels })));
  }
  // Rows inside the window are window rows, whatever loaded them (spec "Window setting change").
  store.clearWindowKept(accountId, path, since.toISOString());
  // Every flag batch succeeded (a failure throws and ends the round), so a uid
  // the server returned nothing for is gone from it.
  const gone = checked.filter((uid) => !onServer.has(uid));
  const removed = gone.length > 0 ? store.deleteByUids(accountId, path, gone) : 0;
  return { backfilled, removed, flagsChanged };
}

/**
 * Where the history check of a folder starts when it is due (spec
 * resolution 9): history was loaded and the last check is missing or older
 * than HISTORY_CHECK_EVERY_MS. Null when there is nothing to check.
 */
function historyDue(store: MailStore, accountId: string, path: string, now: Date): string | null {
  const state = store.historyState(accountId, path);
  if (state === null || state.historySince === null) return null;
  const checkedAt = state.historyCheckedAt === null ? null : Date.parse(state.historyCheckedAt);
  if (checkedAt !== null && Number.isFinite(checkedAt) && now.getTime() - checkedAt < HISTORY_CHECK_EVERY_MS) return null;
  return state.historySince;
}

/** Stores the X-GM-LABELS a Gmail session reported; entries without labels (other servers) are left out. */
function storeLabels(
  store: MailStore,
  accountId: string,
  path: string,
  entries: readonly { uid: number; labels?: string[] | undefined }[],
): void {
  const reported = entries.flatMap((entry) => (entry.labels === undefined ? [] : [{ uid: entry.uid, labels: entry.labels }]));
  if (reported.length > 0) store.setGmLabels(accountId, path, reported);
}

/**
 * The message as the store takes it: unsubscribe info, (slice 3g) the local
 * dev class when classification is on for the folder, and (slice 3i) the
 * sender check, signed or encrypted kind and receipt request. A failed check
 * gets no dev class whatever the folder says (resolution 2); an encrypted
 * body is dropped here, before the store sees it (resolution 6). Nothing
 * here writes to the server. Slice 3h jobs call it with the same context, so
 * their rows are judged like synced rows (spec resolution 7).
 */
export function prepareMessage(message: FetchedMessage, context: PrepareContext): FetchedMessage {
  let out = withSecurity(withUnsubscribe(message, context.preset), context);
  if (out.senderCheck?.state === "failed") return { ...out, dev: null };
  if (context.classifyDev) {
    // The store keeps the List-Id itself, from the same bulk headers.
    const listId = message.bulkHeaders === undefined ? null : normalizeListId(message.bulkHeaders.listId);
    const headers =
      message.devHeaders === undefined ? null : new Map(message.devHeaders.map((line) => [line.key.toLowerCase(), line.value] as const));
    const dev = classifyDev({
      from: message.from.address,
      subject: message.subject,
      headers,
      listId,
      knownHosts: context.devHosts,
    });
    out = { ...out, dev };
  }
  return out;
}

/**
 * The message with its unsubscribe info judged from the fetched header lines
 * (spec "Parsing at sync"): absent headers leave the stored info alone.
 */
function withUnsubscribe(message: FetchedMessage, preset: AccountPreset): FetchedMessage {
  if (message.unsubscribeHeaders === undefined) return message;
  return { ...message, unsubscribe: unsubscribeInfoOf(message.unsubscribeHeaders, preset, message.from) };
}

/**
 * Slice 3i: the sender check from the kept header lines (absent headers
 * leave the stored check alone), and the crypto kind from the top
 * Content-Type and the first non-blank text line (only when the fetch read
 * headers). Encrypted bodies are nulled; the store then keeps an empty
 * snippet and indexes nothing.
 */
function withSecurity(message: FetchedMessage, context: PrepareContext): FetchedMessage {
  let out = message;
  if (message.unsubscribeHeaders !== undefined) {
    out = { ...out, senderCheck: senderCheckOf(message.unsubscribeHeaders, context.preset, message.from, { folderRole: context.folderRole }) };
  }
  if (message.contentType !== undefined) {
    const crypto = cryptoKindOf(message.contentType, firstNonBlankLine(message.bodyText));
    out = { ...out, crypto };
    if (isEncrypted(crypto?.kind)) out = { ...out, bodyText: null, bodyHtml: null };
  }
  return out;
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
