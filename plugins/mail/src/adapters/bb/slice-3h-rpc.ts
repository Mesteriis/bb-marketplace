// Slice 3h server RPCs: server search, older mail and conversation jobs,
// saved searches, folder management, Gmail labels, attachment view tickets,
// Files, attachment text, related mail and the sender card. server.ts wraps
// each in the owner guard (`refusePluginCaller`); this module holds the
// work.
//
// - Folder writes run through the account's write queue on fresh
//   connections with nothing selected (the gateway's folder commands), so
//   nothing is ever expunged: DELETE only at STATUS messages = 0 on the
//   same connection, emptying only by MOVE to Trash, Gmail label folders by
//   a plain DELETE (spec resolution 5). After each operation the folders
//   are listed again, the AI scope reloaded and a sync queued.
// - Labels change by STORE X-GM-LABELS on All Mail through the write queue;
//   undo records only the per-message deltas, and a refused STORE records
//   nothing (spec resolution 10).
// - Logs carry account ids, counts and outcome codes: never a query, a
//   folder or label name, a file name or an excerpt.
import { ownAddresses } from "../../core/compose.ts";
import { RHYTHM_DAYS, RHYTHM_MESSAGES, senderInsights } from "../../core/sender-rhythm.ts";
import {
  ATTACHMENT_TEXT_TOTAL_MAX,
  RELATED_BODY_CHARS,
  SAVED_SEARCHES_MAX,
  VIEW_CAPS,
  ImapAuthError,
  blockCandidates,
  folderOpRefusal,
  gmailLabelFolder,
  imapConfigOf,
  isViewable,
  labelDeltas,
  labelsGroup,
  matchesBlock,
  ownerLabels,
  parseQuery,
  plainBodyText,
  planServerSearch,
  relatedTerms,
  scoreRelated,
  underGmailSystem,
  validFolderName,
  validLabelName,
  validSavedSearch,
  type AccountWriteQueue,
  type Clock,
  type FileKind,
  type FileRow,
  type Folder,
  type FolderNameRefusal,
  type FolderOpRefusal,
  type FolderSession,
  type ImapGateway,
  type LabelUndoChange,
  type MailStore,
  type MessageSummary,
  type ParsedQuery,
  type RemoteFolder,
  type RelatedReason,
  type SavedSearchView,
  type SecretVault,
  type SenderCard,
  type StoredAccount,
  type ThreadFilter,
} from "../../core/index.ts";
import type { AttachmentIndexer } from "./attachment-indexer.ts";
import type { ServerJobs } from "./server-search-jobs.ts";
import type { UndoBook } from "./undo-book.ts";

/** A refusal the server turns into a PluginRpcRefusal. */
export class Slice3hRefusal extends Error {
  constructor(
    readonly code: "conflict" | "invalid" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "Slice3hRefusal";
  }
}

const refuse = (code: Slice3hRefusal["code"], message: string) => new Slice3hRefusal(code, message);

export const UNKNOWN_ACCOUNT_MESSAGE = "Unknown account";
export const UNKNOWN_FOLDER_MESSAGE = "Unknown folder";
export const UNKNOWN_JOB_MESSAGE = "This search or load has ended; start it again";
export const JOB_BUSY_MESSAGE = "The server search is still running";
export const NOTHING_TO_SEARCH_MESSAGE = "Nothing in this search can be sent to the server";
export const NOT_SYNCED_MESSAGE = "Sync this folder first";
export const SAVED_SEARCHES_FULL_MESSAGE = `You can keep up to ${SAVED_SEARCHES_MAX} saved searches`;
export const SAVED_SEARCH_GONE_MESSAGE = "This saved search was deleted";
export const NEW_MAIL_ARRIVED_MESSAGE = "New mail arrived in the folder; it was not deleted";
export const FOLDER_CHANGED_MESSAGE = "The folder changed on the server; check it again";
export const NO_TRASH_MESSAGE = "This account has no Trash folder to move the messages to";
export const MOVE_UNSUPPORTED_MESSAGE = "This server cannot move mail; empty the folder in another app first";
export const SERVER_REFUSED_MESSAGE = "The server refused the change";
export const SERVER_UNREACHABLE_MESSAGE = "Could not reach the server; try again";
export const FOLDER_EXISTS_MESSAGE = "A folder with that name exists";
export const LABELS_GMAIL_ONLY_MESSAGE = "Labels are a Gmail feature";
export const LABELS_NOT_SYNCED_MESSAGE = "Sync this account first";
export const LABELS_REFUSED_MESSAGE = "Gmail refused the label change";
export const UNKNOWN_MESSAGE = "Unknown message";
export const NOT_VIEWABLE_MESSAGE = "This file cannot be shown here; download it";
export const VIEW_TOO_LARGE_MESSAGE = "This file is too large to show here; download it";
export const UNKNOWN_ATTACHMENT_MESSAGE = "Unknown attachment";

export const FOLDER_REFUSAL_MESSAGES: Record<FolderOpRefusal, string> = {
  inbox: "Inbox cannot be renamed or deleted",
  special_use: "System folders cannot be renamed or deleted",
  gmail_system: "Gmail's own folders cannot be renamed or deleted",
  snooze_folder: "Snoozed mail waits in this folder; it cannot be renamed or deleted",
  has_children: "Delete the folders inside it first",
  move_pending: "Messages are still moving in or out of this folder; try again shortly",
  parent_not_selectable: "The folder above it cannot hold folders",
};

export function folderNameMessage(reason: FolderNameRefusal | "parent", delimiter: string): string {
  switch (reason) {
    case "empty":
      return "Enter a folder name";
    case "too_long":
      return "Use at most 100 characters";
    case "control":
      return "The name has characters a folder cannot have";
    case "delimiter":
      return `The name cannot contain "${delimiter}"`;
    case "reserved":
      return "That name is reserved";
    case "exists":
      return FOLDER_EXISTS_MESSAGE;
    case "special_use":
      return "That name is used for system folders";
    case "parent":
      return "Folders cannot be made there";
  }
}

const LABEL_NAME_MESSAGES = {
  empty: "Enter a label name",
  too_long: "Use at most 100 characters",
  control: "The label has characters a label cannot have",
  system: "That is a Gmail system label",
} as const;

/** How many saved-search hits the rail counts (spec: the search capped at 500 rows). */
export const SAVED_COUNT_CAP = 500;
/** A saved search's rail count is computed at most this often. */
export const SAVED_COUNT_TTL_MS = 30_000;
/** Messages moved per MOVE when a folder is emptied into Trash. */
export const FOLDER_MOVE_BATCH = 500;

/** What a view ticket stands for. */
export type ViewRequest = { kind: "view"; messageId: string; partId: string };

export type Slice3hDeps = {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  vaultReady: () => boolean;
  clock: Clock;
  queue: AccountWriteQueue;
  jobs: ServerJobs;
  indexer: AttachmentIndexer;
  undo: UndoBook;
  /** Mints a one-time view ticket; returns the URL the page fetches. */
  viewUrl: (request: ViewRequest) => string;
  newId: () => string;
  /** The account's mail changed: publish and queue a sync. */
  changed: (accountId: string) => void;
  /** Folder listings changed: reload the in-memory AI scope and the IDLE watches. */
  foldersChanged: () => void;
  /** The owner's "Search inside attachments" setting; a round starts when it is on. */
  indexAttachmentText: () => boolean;
  startIndexing: () => void;
  messages: { needsKey: string; passwordNeeded: string };
  log: (line: string) => void;
};

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** A gateway failure as a fixed refusal; never server text. */
function serverRefusal(error: unknown, passwordNeeded: string): Slice3hRefusal {
  if (error instanceof Slice3hRefusal) return error;
  if (error instanceof ImapAuthError) return refuse("conflict", passwordNeeded);
  switch (codeOf(error)) {
    case "NotEmpty":
      return refuse("conflict", NEW_MAIL_ARRIVED_MESSAGE);
    case "MoveUnsupported":
      return refuse("conflict", MOVE_UNSUPPORTED_MESSAGE);
    case "LabelsRefused":
      return refuse("conflict", LABELS_REFUSED_MESSAGE);
    case "CreateFailed":
    case "RenameFailed":
    case "DeleteFailed":
    case "SubscribeFailed":
    case "StatusFailed":
    case "MoveFailed":
      return refuse("conflict", SERVER_REFUSED_MESSAGE);
    default:
      return refuse("conflict", SERVER_UNREACHABLE_MESSAGE);
  }
}

/** The search cursor as the page carries it (base64url JSON of `{ date, id }`). */
export function encodeCursor(cursor: { date: string | null; id: string } | null): string | null {
  return cursor === null ? null : Buffer.from(JSON.stringify([cursor.date, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(text: string | null | undefined): { date: string | null; id: string } | null {
  if (text === null || text === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && (value[0] === null || typeof value[0] === "string") && typeof value[1] === "string") {
      return { date: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw refuse("invalid", "Unknown search page");
}

/** Whether the account is Gmail, for folder rules (the folder listing tells without a session). */
function isGmail(account: StoredAccount, folders: readonly Folder[]): boolean {
  return account.preset === "gmail" || folders.some((f) => f.specialUse === "all" && underGmailSystem(f.path));
}

function childrenOf(folders: readonly { path: string }[], path: string, delimiter: string): number {
  if (delimiter === "") return 0;
  return folders.filter((f) => f.path.startsWith(path + delimiter)).length;
}

/**
 * The account's hierarchy delimiter as the stored listing shows it: the
 * character before a folder's own name in its path ("/" when no folder is
 * nested). Folder writes use the fresh listing's delimiter instead.
 */
function delimiterOf(folders: readonly Folder[], _path: string | null): string {
  for (const f of folders) {
    if (f.path.length > f.name.length + 1 && f.path.endsWith(f.name)) return f.path.charAt(f.path.length - f.name.length - 1);
  }
  return "/";
}

/** The fresh listing's delimiter for a path, else the stored guess. */
function listedDelimiter(listing: readonly RemoteFolder[], path: string, fallback: string): string {
  return listing.find((f) => f.path === path)?.delimiter ?? fallback;
}

export function createSlice3hRpc(deps: Slice3hDeps) {
  const { store, gateway, queue } = deps;
  const now = () => deps.clock.now();
  const savedCounts = new Map<string, { at: number; unread: number; capped: boolean }>();

  function account(accountId: string): StoredAccount {
    const found = store.getAccount(accountId);
    if (found === null) throw refuse("not_found", UNKNOWN_ACCOUNT_MESSAGE);
    return found;
  }

  /** An account the server can be reached for: a key, a working password. */
  function usable(accountId: string): StoredAccount {
    const found = account(accountId);
    if (!deps.vaultReady()) throw refuse("conflict", deps.messages.needsKey);
    if (found.authFailed) throw refuse("conflict", deps.messages.passwordNeeded);
    return found;
  }

  function folderOf(accountId: string, path: string): { folders: Folder[]; folder: Folder } {
    const folders = store.listFolders(accountId);
    const folder = folders.find((f) => f.path === path);
    if (folder === undefined) throw refuse("not_found", UNKNOWN_FOLDER_MESSAGE);
    return { folders, folder };
  }

  /** Lists the account's folders again; a failure is logged and left to the next full round. */
  async function relist(accountId: string, config: ReturnType<typeof imapConfigOf>): Promise<void> {
    try {
      const listing = await gateway.listFolders(config);
      store.saveFolders(accountId, listing);
    } catch (error) {
      deps.log(`folders ${accountId}: listing failed (${codeOf(error) ?? "error"})`);
    }
    deps.foldersChanged();
    deps.changed(accountId);
  }

  /** Runs a folder or label write in the account's queue; gateway errors become fixed refusals. */
  async function write<T>(accountId: string, op: string, task: (config: ReturnType<typeof imapConfigOf>) => Promise<T>): Promise<T> {
    usable(accountId);
    try {
      return await queue.run(accountId, async () => {
        const fresh = usable(accountId);
        return task(imapConfigOf(fresh, deps.vault));
      });
    } catch (error) {
      const refusal = serverRefusal(error, deps.messages.passwordNeeded);
      deps.log(`${op} ${accountId}: refused (${codeOf(error) ?? refusal.code})`);
      throw refusal;
    }
  }

  function refusalFor(accountId: string, folder: Folder, folders: Folder[], op: "rename" | "delete"): FolderOpRefusal | null {
    const owner = account(accountId);
    const delimiter = delimiterOf(folders, folder.path);
    const parentPath = delimiter === "" ? null : folder.path.includes(delimiter) ? folder.path.slice(0, folder.path.lastIndexOf(delimiter)) : null;
    const parent = parentPath === null ? undefined : folders.find((f) => f.path === parentPath);
    return folderOpRefusal(
      { path: folder.path, specialUse: folder.specialUse, selectable: folder.selectable },
      {
        op,
        children: childrenOf(folders, folder.path, delimiter),
        snoozeFolder: owner.snoozeFolder,
        gmail: isGmail(owner, folders),
        movePending: store.movePendingCount(accountId, folder.path),
        parentSelectable: parent === undefined ? true : parent.selectable,
      },
    );
  }

  /** The new path for `name` under `parentPath`, checked against the name rules and the stored folders. */
  function newPath(folders: Folder[], parentPath: string | null, rawName: string, except: string | null): string {
    const delimiter = delimiterOf(folders, parentPath);
    const siblings = folders
      .filter((f) => f.path !== except)
      .filter((f) => {
        const cut = delimiter === "" ? -1 : f.path.lastIndexOf(delimiter);
        const parent = cut === -1 ? null : f.path.slice(0, cut);
        return parent === parentPath;
      })
      .map((f) => (delimiter === "" ? f.path : f.path.slice(f.path.lastIndexOf(delimiter) + 1)));
    const checked = validFolderName(rawName, { delimiter, siblings, namedLikeSpecialUse: (name) => gateway.namedLikeSpecialUse(name) });
    if (!checked.ok) throw refuse("invalid", folderNameMessage(checked.reason, delimiter));
    const path = parentPath === null ? checked.name : `${parentPath}${delimiter}${checked.name}`;
    if (folders.some((f) => f.path !== except && f.path.toLowerCase() === path.toLowerCase())) {
      throw refuse("invalid", FOLDER_EXISTS_MESSAGE);
    }
    return path;
  }

  // ---- Server search and older mail ---------------------------------------

  function serverSearchStart(input: { query: string; accountId: string | null }) {
    if (!deps.vaultReady()) throw refuse("conflict", deps.messages.needsKey);
    const parsed = parseQuery(input.query, now());
    const accounts =
      input.accountId === null
        ? store.listAccounts().filter((a) => !a.authFailed)
        : [usable(input.accountId)];
    const searchable = accounts.filter(
      (a) => planServerSearch(parsed, { gmail: a.preset === "gmail" }, store.listFolders(a.id)).kind !== "refused",
    );
    if (searchable.length === 0) throw refuse("invalid", NOTHING_TO_SEARCH_MESSAGE);
    const started = deps.jobs.startSearch(parsed, searchable.map((a) => a.id));
    deps.log(`server search ${started.jobId}: ${searchable.length} accounts`);
    return started;
  }

  function serverSearchMore(input: { jobId: string }) {
    const answer = deps.jobs.more(input.jobId);
    if (answer === "not_found") throw refuse("not_found", UNKNOWN_JOB_MESSAGE);
    if (answer === "busy") throw refuse("conflict", JOB_BUSY_MESSAGE);
    return { ok: answer === "started" };
  }

  function historyLoad(input: { accountId: string; folder: string }) {
    usable(input.accountId);
    const started = deps.jobs.startHistory(input.accountId, input.folder);
    if ("refused" in started) {
      throw started.refused === "not_found" ? refuse("not_found", UNKNOWN_FOLDER_MESSAGE) : refuse("conflict", NOT_SYNCED_MESSAGE);
    }
    return started;
  }

  function conversationLoad(input: { threadId: string }) {
    if (!deps.vaultReady()) throw refuse("conflict", deps.messages.needsKey);
    const detail = store.getThread(input.threadId, "");
    if (detail === null) throw refuse("not_found", "Unknown thread");
    usable(detail.thread.accountId);
    const started = deps.jobs.startConversation(input.threadId);
    if ("refused" in started) throw refuse("not_found", "Unknown thread");
    return started;
  }

  function jobPoll(input: { jobId: string }) {
    const view = deps.jobs.poll(input.jobId);
    if (view === null) throw refuse("not_found", UNKNOWN_JOB_MESSAGE);
    return view;
  }

  function historyForget(input: { accountId: string; folder: string }) {
    folderOf(input.accountId, input.folder);
    const removed = store.historyForget(input.accountId, input.folder);
    deps.log(`history forget ${input.accountId}: ${removed} rows`);
    if (removed > 0) deps.changed(input.accountId);
    return { removed };
  }

  // ---- Saved searches -------------------------------------------------------

  function unreadCount(row: { id: string; query: string; accountId: string | null }): { unread: number; capped: boolean } {
    const key = `${row.id}\u0000${row.query}\u0000${row.accountId ?? ""}`;
    const cached = savedCounts.get(key);
    const at = now().getTime();
    if (cached !== undefined && at - cached.at < SAVED_COUNT_TTL_MS) return cached;
    const parsed = parseQuery(row.query, now());
    const unread: ParsedQuery = { ...parsed, conditions: [...parsed.conditions, { field: "is", value: "unread", negated: false }], unread: true };
    let hits = 0;
    try {
      hits = store.search(unread, row.accountId, SAVED_COUNT_CAP + 1).length;
    } catch {
      hits = 0;
    }
    const counted = { at, unread: Math.min(hits, SAVED_COUNT_CAP), capped: hits > SAVED_COUNT_CAP };
    savedCounts.set(key, counted);
    return counted;
  }

  /** Drops the cached counts of a saved search that was edited or deleted. */
  function forgetCounts(id: string): void {
    for (const key of [...savedCounts.keys()]) if (key.startsWith(`${id}\u0000`)) savedCounts.delete(key);
  }

  function savedSearchesList(): { searches: SavedSearchView[] } {
    return {
      searches: store.listSavedSearches().map((row) => {
        const { unread, capped } = unreadCount(row);
        return { id: row.id, name: row.name, query: row.query, accountId: row.accountId, unread, capped };
      }),
    };
  }

  function savedSearchSave(input: { id?: string; name: string; query: string; accountId: string | null }) {
    const checked = validSavedSearch(input);
    if (!checked.ok) throw refuse("invalid", checked.reason === "name" ? "Name the search (up to 60 characters)" : "Enter a search");
    if (input.accountId !== null) account(input.accountId);
    const saved = store.saveSavedSearch(
      { id: input.id ?? null, name: checked.name, query: checked.query, accountId: input.accountId, nowIso: now().toISOString() },
      `ss_${deps.newId()}`,
    );
    if (saved === "full") throw refuse("conflict", SAVED_SEARCHES_FULL_MESSAGE);
    if (saved === "not_found") throw refuse("not_found", SAVED_SEARCH_GONE_MESSAGE);
    if (input.id !== undefined) forgetCounts(input.id);
    return saved;
  }

  // ---- Folders --------------------------------------------------------------

  async function folderCreate(input: { accountId: string; parent: string | null; name: string }) {
    usable(input.accountId);
    const folders = store.listFolders(input.accountId);
    if (input.parent !== null) {
      if (!folders.some((f) => f.path === input.parent)) throw refuse("not_found", UNKNOWN_FOLDER_MESSAGE);
      if (underGmailSystem(input.parent)) throw refuse("invalid", folderNameMessage("parent", ""));
    }
    const path = newPath(folders, input.parent, input.name, null);
    const made = await write(input.accountId, "folder create", async (config) => {
      const created = await gateway.createFolder(config, path);
      if (!created.created) throw refuse("conflict", FOLDER_EXISTS_MESSAGE);
      await relist(input.accountId, config);
      return created.path;
    });
    deps.log(`folder create ${input.accountId}: ok`);
    return { path: made };
  }

  async function folderRename(input: { accountId: string; path: string; name: string }) {
    usable(input.accountId);
    const { folders, folder } = folderOf(input.accountId, input.path);
    const refusal = refusalFor(input.accountId, folder, folders, "rename");
    if (refusal !== null) throw refuse("conflict", FOLDER_REFUSAL_MESSAGES[refusal]);
    const delimiter = delimiterOf(folders, folder.path);
    const parent = delimiter !== "" && folder.path.includes(delimiter) ? folder.path.slice(0, folder.path.lastIndexOf(delimiter)) : null;
    const to = newPath(folders, parent, input.name, folder.path);
    const renamed = await write(input.accountId, "folder rename", async (config) => {
      // Checked again inside the queue: a round may have queued moves meanwhile.
      const again = folderOf(input.accountId, input.path);
      const late = refusalFor(input.accountId, again.folder, again.folders, "rename");
      if (late !== null) throw refuse("conflict", FOLDER_REFUSAL_MESSAGES[late]);
      const exact = listedDelimiter(await gateway.listFolders(config), input.path, delimiter);
      const { path } = await gateway.renameFolder(config, input.path, to);
      // Right after the server's OK, before the listing (spec resolution 8).
      store.rehomeFolder(input.accountId, input.path, path, exact);
      await relist(input.accountId, config);
      return path;
    });
    deps.log(`folder rename ${input.accountId}: ok`);
    return { path: renamed };
  }

  async function folderDeleteCheck(input: { accountId: string; path: string }) {
    usable(input.accountId);
    const { folders, folder } = folderOf(input.accountId, input.path);
    const owner = account(input.accountId);
    const children = childrenOf(folders, folder.path, delimiterOf(folders, folder.path));
    const refusal = refusalFor(input.accountId, folder, folders, "delete");
    const gmailLabel = gmailLabelFolder(
      { path: folder.path, specialUse: folder.specialUse, selectable: folder.selectable },
      isGmail(owner, folders),
    );
    if (refusal !== null || !folder.selectable) return { messages: 0, children, gmailLabel, refusal };
    const status = await write(input.accountId, "folder check", (config) => gateway.folderStatus(config, folder.path));
    return { messages: status.messages, children, gmailLabel, refusal };
  }

  async function folderDelete(input: { accountId: string; path: string; moveToTrash: boolean; expectedMessages: number }) {
    usable(input.accountId);
    const { folders, folder } = folderOf(input.accountId, input.path);
    const refusal = refusalFor(input.accountId, folder, folders, "delete");
    if (refusal !== null) throw refuse("conflict", FOLDER_REFUSAL_MESSAGES[refusal]);
    const owner = account(input.accountId);
    const gmailLabel = gmailLabelFolder({ path: folder.path, specialUse: folder.specialUse, selectable: folder.selectable }, isGmail(owner, folders));
    const delimiter = delimiterOf(folders, folder.path);
    const trash = folders.find((f) => f.specialUse === "trash" && f.selectable);
    if (!gmailLabel && input.moveToTrash && trash === undefined) throw refuse("conflict", NO_TRASH_MESSAGE);
    if (!gmailLabel && !input.moveToTrash && input.expectedMessages !== 0) throw refuse("invalid", FOLDER_CHANGED_MESSAGE);

    const moved = await write(input.accountId, "folder delete", async (config) => {
      const again = folderOf(input.accountId, input.path);
      const late = refusalFor(input.accountId, again.folder, again.folders, "delete");
      if (late !== null) throw refuse("conflict", FOLDER_REFUSAL_MESSAGES[late]);
      // Children rechecked against a fresh listing.
      const listing = await gateway.listFolders(config);
      if (childrenOf(listing, folder.path, listedDelimiter(listing, folder.path, delimiter)) > 0) throw refuse("conflict", FOLDER_REFUSAL_MESSAGES.has_children);
      let count = 0;
      if (folder.selectable) {
        const status = await gateway.folderStatus(config, folder.path);
        if (status.messages !== input.expectedMessages) throw refuse("conflict", FOLDER_CHANGED_MESSAGE);
      }
      if (gmailLabel) {
        // A Gmail label folder: DELETE removes the label only (spec resolution 5);
        // the gateway checks for STATUS 0 instead when the server lacks X-GM-EXT-1.
        await gateway.deleteFolder(config, folder.path, { expectEmpty: true, gmailLabel: true });
      } else {
        if (input.moveToTrash && input.expectedMessages > 0) count = await emptyIntoTrash(input.accountId, config, folder.path, trash!.path);
        // A \Noselect folder (stored and listed so) holds no messages: no STATUS.
        const selectable = folder.selectable || listing.some((f) => f.path === folder.path && f.selectable);
        await gateway.deleteFolder(config, folder.path, { expectEmpty: selectable });
      }
      store.dropFolder(input.accountId, folder.path);
      await relist(input.accountId, config);
      return count;
    });
    deps.log(`folder delete ${input.accountId}: ok, moved ${moved}`);
    return { ok: true, moved };
  }

  /**
   * Moves every message of the folder to Trash with MOVE, 500 uids at a
   * time (rows re-homed as 3a's moves are), then checks the count: mail that
   * arrived meanwhile stops the delete.
   */
  async function emptyIntoTrash(accountId: string, config: ReturnType<typeof imapConfigOf>, path: string, trash: string): Promise<number> {
    let session: FolderSession | null = null;
    let moved = 0;
    try {
      session = await gateway.openFolder(config, path, { readOnly: false });
      const uids = await session.uidsAfter(0);
      for (let i = 0; i < uids.length; i += FOLDER_MOVE_BATCH) {
        const batch = uids.slice(i, i + FOLDER_MOVE_BATCH);
        const result = await session.moveMessages(batch, trash);
        store.completeMove(accountId, path, trash, result.moved, batch);
        moved += batch.length;
      }
    } finally {
      if (session !== null) await session.close().catch(() => undefined);
    }
    const after = await gateway.folderStatus(config, path);
    if (after.messages > 0) throw refuse("conflict", NEW_MAIL_ARRIVED_MESSAGE);
    return moved;
  }

  async function folderSubscribe(input: { accountId: string; path: string; subscribed: boolean }) {
    usable(input.accountId);
    folderOf(input.accountId, input.path);
    await write(input.accountId, "folder subscribe", async (config) => {
      await gateway.setSubscribed(config, input.path, input.subscribed);
      await relist(input.accountId, config);
    });
    return { ok: true };
  }

  function folderPrefsSet(input: { accountId: string; path: string; grouping: boolean }) {
    if (input.accountId !== "*") folderOf(input.accountId, input.path);
    store.setFolderGrouping(input.accountId, input.path, input.grouping);
    return { ok: true };
  }

  function messagesList(input: {
    scope: { kind: "account"; accountId: string; folder: string } | { kind: "all"; role: Folder["specialUse"] & string };
    cursor: string | null;
    limit: number;
    filter?: ThreadFilter;
  }): { messages: MessageSummary[]; nextCursor: string | null } {
    if (input.scope.kind === "account") return store.listMessages(input.scope.accountId, input.scope.folder, input.cursor, input.limit, input.filter);
    if (input.scope.role === "all") throw refuse("invalid", "All Mail is not a merged folder");
    return store.listMessagesAll(input.scope.role, input.cursor, input.limit, input.filter);
  }

  // ---- Labels ---------------------------------------------------------------

  function allMailOf(accountId: string): Folder {
    const owner = account(accountId);
    const folders = store.listFolders(accountId);
    if (!isGmail(owner, folders)) throw refuse("invalid", LABELS_GMAIL_ONLY_MESSAGE);
    const allMail = folders.find((f) => f.specialUse === "all" && f.selectable);
    if (allMail === undefined) throw refuse("conflict", LABELS_NOT_SYNCED_MESSAGE);
    return allMail;
  }

  function labelsList(input: { accountId: string }) {
    const folders = store.listFolders(input.accountId);
    account(input.accountId);
    const labels = ownerLabels(store.accountLabels(input.accountId));
    // Label folders the listing has, even without a stored message carrying them.
    const owner = account(input.accountId);
    if (isGmail(owner, folders)) {
      for (const f of folders) {
        if (f.specialUse === null && f.path.toUpperCase() !== "INBOX" && !underGmailSystem(f.path) && !labels.includes(f.path)) labels.push(f.path);
      }
    }
    labels.sort((a, b) => a.localeCompare(b));
    return { labels: labels.map((name) => ({ name, path: folders.find((f) => f.path === name)?.path ?? null })) };
  }

  /** Label names checked: added ones must be valid owner labels; removed ones may not be system labels. */
  function checkedLabels(names: readonly string[]): string[] {
    return [
      ...new Set(
        names.map((raw) => {
          const checked = validLabelName(raw);
          if (!checked.ok) throw refuse("invalid", LABEL_NAME_MESSAGES[checked.reason]);
          return checked.name;
        }),
      ),
    ];
  }

  async function labelsChange(input: { messageIds: string[]; add: string[]; remove: string[]; undoId?: string }) {
    const add = checkedLabels(input.add);
    const remove = checkedLabels(input.remove);
    const messages = input.messageIds.map((id) => {
      const message = store.getMessage(id);
      if (message === null) throw refuse("not_found", UNKNOWN_MESSAGE);
      return message;
    });
    const byAccount = new Map<string, string[]>();
    for (const message of messages) byAccount.set(message.accountId, [...(byAccount.get(message.accountId) ?? []), message.id]);
    let changed = 0;
    for (const [accountId, ids] of byAccount) {
      usable(accountId);
      const allMail = allMailOf(accountId);
      const copies = store.copiesIn(allMail.path, ids);
      if (ids.some((id) => copies.get(id)?.uid == null)) throw refuse("conflict", LABELS_NOT_SYNCED_MESSAGE);
      // The before-state is the All Mail copy's (the one the STORE changes).
      const stored = store.gmLabels(ids.map((id) => copies.get(id)!.id));
      const before = new Map(ids.map((id) => [id, stored.get(copies.get(id)!.id) ?? []] as const));
      const deltas = labelDeltas(before, add, remove);
      if (deltas.length === 0) continue;
      const uids = [...new Set(deltas.map((delta) => copies.get(delta.messageId)!.uid!))];
      await write(accountId, "labels", async (config) => {
        const session = await gateway.openFolder(config, allMail.path, { readOnly: false });
        try {
          const now = await session.setLabels(uids, {
            add: add.filter((label) => !remove.includes(label)),
            remove: remove.filter((label) => !add.includes(label)),
          });
          store.setGmLabels(accountId, allMail.path, now);
        } finally {
          await session.close().catch(() => undefined);
        }
      });
      // Only after the server's OK: a refused STORE threw above and records no undo.
      if (input.undoId !== undefined) deps.undo.record(input.undoId, "labels", labelsGroup(accountId, allMail.path, deltas));
      store.promoteKept(deltas.map((delta) => delta.messageId));
      changed += deltas.length;
      deps.changed(accountId);
      deps.log(`labels ${accountId}: ${deltas.length} changed`);
    }
    return { changed };
  }

  /**
   * Undo of a labels group (spec resolution 10): per message, what the
   * change added is removed and what it removed is added back, on the All
   * Mail copy, through the write queue. Returns the ids restored.
   */
  async function undoLabels(step: { accountId: string; changes: LabelUndoChange[] }): Promise<{ restored: string[]; failed: number }> {
    const allMail = store.listFolders(step.accountId).find((f) => f.specialUse === "all" && f.selectable);
    if (allMail === undefined) return { restored: [], failed: step.changes.length };
    const copies = store.copiesIn(allMail.path, step.changes.map((change) => change.messageId));
    const groups = new Map<string, { add: string[]; remove: string[]; uids: number[]; ids: string[] }>();
    let failed = 0;
    for (const change of step.changes) {
      const uid = copies.get(change.messageId)?.uid ?? null;
      if (uid === null) {
        failed++;
        continue;
      }
      const key = JSON.stringify([[...change.add].sort(), [...change.remove].sort()]);
      const group = groups.get(key) ?? { add: change.add, remove: change.remove, uids: [], ids: [] };
      group.uids.push(uid);
      group.ids.push(change.messageId);
      groups.set(key, group);
    }
    const restored: string[] = [];
    try {
      await write(step.accountId, "labels undo", async (config) => {
        const session = await gateway.openFolder(config, allMail.path, { readOnly: false });
        try {
          for (const group of groups.values()) {
            const now = await session.setLabels(group.uids, { add: group.add, remove: group.remove });
            store.setGmLabels(step.accountId, allMail.path, now);
            restored.push(...group.ids);
          }
        } finally {
          await session.close().catch(() => undefined);
        }
      });
    } catch {
      failed += step.changes.length - restored.length - failed;
    }
    if (restored.length > 0) deps.changed(step.accountId);
    return { restored, failed };
  }

  // ---- Attachments, files, related, sender ----------------------------------

  function attachmentViewTicket(input: { messageId: string; partId: string }) {
    const header = store.getMessage(input.messageId);
    if (header === null) throw refuse("not_found", UNKNOWN_MESSAGE);
    const part = header.attachments.find((a) => a.partId === input.partId);
    if (part === undefined) throw refuse("not_found", UNKNOWN_ATTACHMENT_MESSAGE);
    if (!isViewable(part.kind, part.mimeType)) throw refuse("invalid", NOT_VIEWABLE_MESSAGE);
    const cap = part.kind === "image" ? VIEW_CAPS.image : part.kind === "pdf" ? VIEW_CAPS.pdf : null;
    if (cap !== null && part.size > cap) throw refuse("invalid", VIEW_TOO_LARGE_MESSAGE);
    if (!deps.vaultReady()) throw refuse("conflict", deps.messages.needsKey);
    const url = deps.viewUrl({ kind: "view", messageId: input.messageId, partId: input.partId });
    return { url, kind: part.kind as FileKind, mimeType: part.mimeType, size: part.size };
  }

  function filesList(input: {
    kind?: FileKind;
    sender?: string;
    accountId?: string;
    name?: string;
    includeJunk?: boolean;
    cursor: string | null;
    limit: number;
  }): { files: FileRow[]; nextCursor: string | null } {
    const { cursor, limit, ...filter } = input;
    return store.filesList(filter, cursor, limit);
  }

  function attachmentTextStatus() {
    const status = store.attachmentTextStatus();
    return {
      indexed: status.indexed,
      skipped: status.skipped,
      failed: status.failed,
      pending: status.pending,
      running: deps.indexer.running(),
      full: status.totalChars >= ATTACHMENT_TEXT_TOTAL_MAX,
    };
  }

  function attachmentTextRetry() {
    const retried = store.retryAttachmentText();
    deps.log(`attachment text: ${retried} to retry`);
    if (deps.indexAttachmentText()) deps.startIndexing();
    return { ok: true };
  }

  function attachmentTextClear() {
    const removed = store.clearAttachmentText();
    deps.log(`attachment text: ${removed} rows removed`);
    return { ok: true };
  }

  function relatedMessages(input: { messageId: string }): { hits: { summary: MessageSummary; reasons: RelatedReason[] }[] } {
    const message = store.getMessage(input.messageId);
    if (message === null) throw refuse("not_found", UNKNOWN_MESSAGE);
    const text = plainBodyText(store.getBody(message.id)).slice(0, RELATED_BODY_CHARS);
    const terms = relatedTerms(message.subject, text);
    const scored = scoreRelated(store.relatedCandidates(message.id, terms), { excludeThreadId: message.threadId });
    const summaries = new Map(store.summaries(scored.map((s) => s.messageId)).map((s) => [s.id, s]));
    return {
      hits: scored.flatMap((s) => {
        const summary = summaries.get(s.messageId);
        return summary === undefined ? [] : [{ summary, reasons: s.reasons }];
      }),
    };
  }

  function senderCard(input: { address: string; accountId: string | null }): SenderCard {
    if (input.accountId !== null) account(input.accountId);
    const address = input.address.trim();
    const stats = store.senderStats(address, input.accountId);
    const accounts = input.accountId === null ? store.listAccounts().map((a) => a.id) : [input.accountId];
    const imagesAllowed = accounts.some((id) => store.isImageSenderAllowed(id, address));
    const blocked = matchesBlock(address, store.listBlockRules()) !== null;
    const { address: normalized, domain } = blockCandidates(address);
    const bindings = store.listBindings();
    const binding =
      bindings.find((b) => b.kind === "address" && b.value === normalized) ??
      (domain === null ? undefined : bindings.find((b) => b.kind === "domain" && b.value === domain));
    return {
      name: stats.name,
      address,
      fromCount: stats.fromCount,
      toCount: stats.toCount,
      toCapped: stats.toCapped,
      firstDate: stats.firstDate,
      lastDate: stats.lastDate,
      conversations: stats.conversations.slice(0, 10),
      files: stats.files.slice(0, 5),
      imagesAllowed,
      blocked,
      projectId: binding?.projectId ?? null,
      insights: senderInsights(
        store.senderExchange(address, input.accountId, new Date(now().getTime() - RHYTHM_DAYS * 86_400_000).toISOString(), RHYTHM_MESSAGES),
        new Set(ownAddresses(store).map((own) => own.trim().toLowerCase())),
      ),
    };
  }

  return {
    serverSearchStart,
    serverSearchMore,
    historyLoad,
    conversationLoad,
    jobPoll,
    jobCancel: (input: { jobId: string }) => ({ ok: deps.jobs.cancel(input.jobId) }),
    historyForgetCheck: (input: { accountId: string; folder: string }) => {
      folderOf(input.accountId, input.folder);
      return { count: store.historyForgetCount(input.accountId, input.folder) };
    },
    historyForget,
    savedSearchesList,
    savedSearchSave,
    savedSearchDelete: (input: { id: string }) => {
      forgetCounts(input.id);
      return { ok: store.deleteSavedSearch(input.id) };
    },
    savedSearchMove: (input: { id: string; position: number }) => ({ ok: store.moveSavedSearch(input.id, input.position) }),
    folderCreate,
    folderRename,
    folderDeleteCheck,
    folderDelete,
    folderSubscribe,
    folderPrefsSet,
    messagesList,
    labelsList,
    labelsChange,
    undoLabels,
    attachmentViewTicket,
    filesList,
    attachmentTextStatus,
    attachmentTextRetry,
    attachmentTextClear,
    relatedMessages,
    senderCard,
  };
}

export type Slice3hRpc = ReturnType<typeof createSlice3hRpc>;
