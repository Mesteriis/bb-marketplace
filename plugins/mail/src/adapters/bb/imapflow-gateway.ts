// ImapGateway on imapflow. TLS only (secure: true whatever the port, never
// STARTTLS or plaintext), one folder per session, every body fetch is
// BODY.PEEK (imapflow fetches `source` with PEEK, `headers` with
// BODY.PEEK[HEADER.FIELDS (...)], and `download` of the whole message fetches
// `source` in chunks), and the only writes are \Seen on
// owner-opened mail (markSeen), owner-clicked or hotkeyed \Seen / \Flagged
// add/remove (setFlags), owner-clicked moves (moveMessages), and for slice 3b
// APPEND of the owner's drafts and Sent copies (appendMessage) and the UID
// EXPUNGE of exactly one superseded draft copy (expungeOwn, UIDPLUS only),
// and for slice 3d the UID COPY of undo of an archive on Gmail
// (copyMessages; it adds, never removes). Slice 3e adds the IDLE watch
// (watchFolder: its own read-only EXAMINE connection, no session, no
// command beyond IDLE and imapflow's keepalive NOOP) and the CREATE of one
// snooze folder after the owner's confirmation (createFolder). Slice 3h adds
// the owner's folder RENAME / DELETE / SUBSCRIBE / UNSUBSCRIBE (each on a
// fresh connection with nothing selected, so imapflow never sends CLOSE,
// which would expunge; DELETE of a non-Gmail folder only after STATUS
// reports it empty on the same connection), STORE X-GM-LABELS on Gmail
// (setLabels), and read-only UID SEARCH by Mail's criteria (searchServer).
// Errors leaving this file are rebuilt from codes: imapflow errors can carry
// server responses and the sent command, so their text is never passed on.
import { AuthenticationFailure, ImapFlow } from "imapflow";
import type { GoogleTokens } from "./google-tokens.ts";
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MessageAddressObject,
  SearchObject,
} from "imapflow";
import { specialUse } from "imapflow/lib/special-use.js";
import PostalMime from "postal-mime";
import { normalizeMessageId } from "../../core/headers.ts";
import type { Address, Attachment, Email, RawEmail } from "postal-mime";
import {
  IDLE_REFUSED_CODE,
  IDLE_RESTART_MS,
  IDLE_SOCKET_TIMEOUT_MS,
  ImapAuthError,
  LIST_HEADER_FIELDS,
  PROVIDER_TRACE_HEADERS,
  UNSUBSCRIBE_HEADER_FIELDS,
  DEV_HEADER_FIELDS,
  capInlineParts,
  receiptRequested,
  type AttachmentMeta,
  type BulkHeaders,
  type FetchedMessage,
  type FlagChange,
  type HeaderLine,
  capHeaderLines,
  type ImapConfig,
  type ImapGateway,
  type FolderSession,
  type InlinePart,
  type MailAddress,
  type RemoteFolder,
  type SpecialUse,
  type ServerCriteria,
  type WatchEnd,
  SERVER_SEARCH_CAPS,
} from "../../core/index.ts";

export interface ImapflowGatewayOptions {
  /** Receives one safe line per connection error; never message or credential text. */
  logger?: (line: string) => void;
  /** Builds the client of a session-less command (tests pass a stub); defaults to imapflow. */
  createClient?: (options: ImapFlowOptions) => ImapFlow;
  /** Access tokens for Google accounts; without it such an account cannot connect. */
  googleTokens?: GoogleTokens;
}

const MESSAGE_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  internalDate: true,
  bodyStructure: true,
  source: true,
  threadId: true,
  // imapflow asks for EMAILID / X-GM-MSGID whenever the server supports it; explicit anyway.
  emailId: true,
};

const FLAGS_QUERY: FetchQueryObject = { uid: true, flags: true, emailId: true };

/** X-GM-LABELS only (slice 3h): a FETCH of labels sets no flag. */
const LABELS_QUERY: FetchQueryObject = { uid: true, labels: true };

/**
 * The bulk backfill: imapflow 2.11 sends `headers: [...]` as
 * BODY.PEEK[HEADER.FIELDS (...)] (never \Seen, no body) and returns the
 * section as `headers`, a Buffer.
 */
export const LIST_HEADERS_QUERY: FetchQueryObject = { uid: true, headers: [...LIST_HEADER_FIELDS] };

/** What the expunge guard and the Message-ID search compare: no body, never \Seen. */
const GUARD_QUERY: FetchQueryObject = { uid: true, envelope: true, size: true };

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** An error this file built: its message and code are safe to pass on as they are. */
export class SafeImapError extends Error {
  constructor(
    readonly code: string,
    message = `IMAP error (${code})`,
  ) {
    super(message);
    this.name = "SafeImapError";
  }
}

/** What a session needs from an imapflow client; tests pass a stub. */
export type SessionClient = Pick<
  ImapFlow,
  | "mailbox"
  | "capabilities"
  | "enabled"
  | "usable"
  | "search"
  | "fetch"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "download"
  | "messageMove"
  | "messageCopy"
  | "append"
  | "messageDelete"
  | "logout"
  | "close"
>;

export type ParseMail = (source: Buffer | string) => Promise<Email>;

const EMPTY_MAIL: Email = { headers: [], headerLines: [], attachments: [] };

/**
 * The one MIME parser of the plugin: fetchMessages uses it, and downloads
 * reuse it so a part index (partId) means the same part in both. Keep the
 * options here; postal-mime is pinned to an exact version for the same reason.
 */
export function parseMail(source: Extract<RawEmail, string | ArrayBuffer | ArrayBufferView>): Promise<Email> {
  return PostalMime.parse(source, { attachmentEncoding: "arraybuffer" });
}

export function createImapflowGateway(options: ImapflowGatewayOptions = {}): ImapGateway {
  const log = options.logger ?? (() => {});

  /**
   * The access token a Google account signs in with; null for a password
   * account. Throws GrantRevokedError, or TokenUnavailable when no token can
   * be had now.
   */
  async function accessTokenFor(config: ImapConfig): Promise<string | null> {
    if (config.authKind !== "google") return null;
    if (options.googleTokens === undefined) throw new SafeImapError("TokenUnavailable");
    return options.googleTokens.accessToken(config.password);
  }

  async function connect(config: ImapConfig): Promise<ImapFlow> {
    const imapflowOptions = toImapflowOptions(config, await accessTokenFor(config));
    const client = options.createClient?.(imapflowOptions) ?? new ImapFlow(imapflowOptions);
    // An unhandled 'error' event would crash the host process.
    client.on("error", (error: unknown) => log(`imap connection error: ${describeImapError(error).message}`));
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.close();
      const mapped = describeImapError(error);
      // A token the server refuses is not offered again: the next sign-in asks for a new one.
      if (mapped instanceof ImapAuthError && config.authKind === "google") options.googleTokens?.forget(config.password);
      throw mapped;
    }
  }

  return {
    async test(config) {
      try {
        const client = await connect(config);
        await logoutQuietly(client);
        return { ok: true };
      } catch (error) {
        const mapped = describeImapError(error);
        return { ok: false, reason: mapped.message, authFailed: mapped instanceof ImapAuthError };
      }
    },

    async listFolders(config) {
      const client = await connect(config);
      try {
        return await listRemoteFolders(client);
      } finally {
        await logoutQuietly(client);
      }
    },

    async openFolder(config, path, { readOnly }) {
      const client = await connect(config);
      try {
        await client.mailboxOpen(path, { readOnly });
      } catch (error) {
        await logoutQuietly(client);
        throw describeImapError(error);
      }
      return createSession(client, readOnly);
    },

    async watchFolder(config, path, onChange, signal) {
      let accessToken: string | null;
      try {
        accessToken = await accessTokenFor(config);
      } catch (error) {
        const mapped = describeImapError(error);
        if (mapped instanceof ImapAuthError) return { kind: "auth" };
        return { kind: "dropped", code: mapped instanceof SafeImapError ? mapped.code : "Unknown" };
      }
      const client = new ImapFlow({
        ...toImapflowOptions(config, accessToken),
        // A quiet socket while idling sends a recovery NOOP after this; one
        // that has not settled by the next timeout closes the connection, so
        // a dead peer is found in about 150 s (spec resolution 15).
        socketTimeout: IDLE_SOCKET_TIMEOUT_MS,
        // imapflow restarts IDLE inside its command at this bound.
        maxIdleTime: IDLE_RESTART_MS,
      });
      return runWatch(client, path, onChange, signal, log);
    },

    async createFolder(config, name) {
      const client = await connect(config);
      try {
        return await createFolderWith(client, name);
      } finally {
        await logoutQuietly(client);
      }
    },

    // Slice 3h folder writes: a fresh connection with nothing selected, logout after.
    async renameFolder(config, from, to) {
      const client = await connect(config);
      try {
        return await renameFolderWith(client, from, to);
      } finally {
        await logoutQuietly(client);
      }
    },
    async folderStatus(config, path) {
      const client = await connect(config);
      try {
        return await folderStatusWith(client, path);
      } finally {
        await logoutQuietly(client);
      }
    },
    async deleteFolder(config, path, deleteOptions) {
      const client = await connect(config);
      try {
        await deleteFolderWith(client, path, deleteOptions);
      } finally {
        await logoutQuietly(client);
      }
    },
    async setSubscribed(config, path, subscribed) {
      const client = await connect(config);
      try {
        await setSubscribedWith(client, path, subscribed);
      } finally {
        await logoutQuietly(client);
      }
    },
    namedLikeSpecialUse,
  };
}

/**
 * Whether imapflow would read a folder of this name as special use when the
 * server has no SPECIAL-USE flags (spec resolution 18): its exact localized
 * names, then decorated ones ("Sent Mail").
 */
export function namedLikeSpecialUse(name: string): boolean {
  return specialUse(false, { name, flags: new Set<string>() }).flag !== null;
}

/** What the session-less folder commands need from an imapflow client; tests pass a stub. */
export type FolderOpsClient = Pick<
  ImapFlow,
  "mailbox" | "mailboxRename" | "mailboxDelete" | "mailboxSubscribe" | "mailboxUnsubscribe" | "status" | "capabilities"
>;

/**
 * imapflow runs CLOSE (which expunges \Deleted mail) before RENAME or DELETE
 * of the selected mailbox. These commands run only with nothing selected;
 * a selected mailbox refuses before any command.
 */
function assertNothingSelected(client: Pick<FolderOpsClient, "mailbox">, code: string): void {
  if (client.mailbox) throw new SafeImapError(code);
}

/** A refusal as the command's code; a refused login stays an auth error. Never the server's text. */
function folderOpError(error: unknown, code: string): Error {
  const mapped = describeImapError(error);
  return mapped instanceof ImapAuthError ? mapped : new SafeImapError(code);
}

/** RENAME `from` to `to`: the new path, or "RenameFailed". */
export async function renameFolderWith(client: FolderOpsClient, from: string, to: string): Promise<{ path: string }> {
  assertNothingSelected(client, "RenameFailed");
  let result: Awaited<ReturnType<ImapFlow["mailboxRename"]>> | undefined;
  try {
    result = await client.mailboxRename(from, to);
  } catch (error) {
    throw folderOpError(error, "RenameFailed");
  }
  if (!result || typeof result.newPath !== "string") throw new SafeImapError("RenameFailed");
  return { path: result.newPath };
}

/** STATUS (MESSAGES UIDVALIDITY) of one folder, or "StatusFailed". Selects nothing. */
export async function folderStatusWith(
  client: Pick<FolderOpsClient, "status">,
  path: string,
): Promise<{ messages: number; uidValidity: number }> {
  let result: Awaited<ReturnType<ImapFlow["status"]>> | undefined;
  try {
    result = await client.status(path, { messages: true, uidValidity: true });
  } catch (error) {
    throw folderOpError(error, "StatusFailed");
  }
  if (!result || typeof result.messages !== "number") throw new SafeImapError("StatusFailed");
  return { messages: result.messages, uidValidity: Number(result.uidValidity ?? 0) };
}

/**
 * DELETE of one folder with nothing selected. `expectEmpty`: STATUS first
 * on the same connection and "NotEmpty" (nothing deleted) above 0 messages;
 * without it (a \Noselect folder, which holds no messages) DELETE only.
 * `gmailLabel` (spec resolution 5): DELETE only, which removes the label and
 * keeps the mail, when this connection advertises X-GM-EXT-1; otherwise the
 * STATUS check as with `expectEmpty`.
 */
export async function deleteFolderWith(
  client: FolderOpsClient,
  path: string,
  options: { expectEmpty: boolean; gmailLabel?: boolean },
): Promise<void> {
  assertNothingSelected(client, "DeleteFailed");
  const gmail = client.capabilities?.has("X-GM-EXT-1") === true;
  const check = options.gmailLabel === true ? !gmail : options.expectEmpty;
  if (check) {
    const { messages } = await folderStatusWith(client, path);
    if (messages > 0) throw new SafeImapError("NotEmpty");
    assertNothingSelected(client, "DeleteFailed");
  }
  let result: Awaited<ReturnType<ImapFlow["mailboxDelete"]>> | undefined;
  try {
    result = await client.mailboxDelete(path);
  } catch (error) {
    throw folderOpError(error, "DeleteFailed");
  }
  if (!result) throw new SafeImapError("DeleteFailed");
}

/** SUBSCRIBE or UNSUBSCRIBE, or "SubscribeFailed". */
export async function setSubscribedWith(client: FolderOpsClient, path: string, subscribed: boolean): Promise<void> {
  let done: boolean;
  try {
    done = subscribed ? await client.mailboxSubscribe(path) : await client.mailboxUnsubscribe(path);
  } catch (error) {
    throw folderOpError(error, "SubscribeFailed");
  }
  if (done !== true) throw new SafeImapError("SubscribeFailed");
}

const DAY_START = "T00:00:00.000Z";

/** One criteria object without NOT and Gmail's raw query as imapflow's SearchObject. */
function plainSearchObject(criteria: ServerCriteria): SearchObject {
  const query: SearchObject = {};
  for (const key of ["text", "from", "to", "cc", "subject"] as const) {
    const value = criteria[key];
    if (typeof value === "string" && value !== "") query[key] = value;
  }
  if (criteria.since !== undefined) query.since = new Date(`${criteria.since}${DAY_START}`);
  if (criteria.before !== undefined) query.before = new Date(`${criteria.before}${DAY_START}`);
  if (criteria.larger !== undefined) query.larger = criteria.larger;
  if (criteria.smaller !== undefined) query.smaller = criteria.smaller;
  if (criteria.seen !== undefined) query.seen = criteria.seen;
  if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
  if (typeof criteria.threadId === "string" && criteria.threadId !== "") query.threadId = criteria.threadId;
  const headers = (criteria.headers ?? []).filter((h) => h.name !== "" && h.value !== "").map((h) => ({ header: { [h.name]: h.value } }));
  if (headers.length === 1) query.header = headers[0]!.header;
  else if (headers.length > 1) query.or = headers;
  return query;
}

/**
 * Mail's criteria as imapflow's SearchObject, or null when nothing would be
 * sent. On Gmail with `gmailRaw` only X-GM-RAW is sent; elsewhere the raw
 * query is dropped (imapflow refuses it without X-GM-EXT-1). Negations are
 * ANDed: NOT a, NOT b is sent as NOT (OR a b).
 */
export function toSearchObject(criteria: ServerCriteria, gmail: boolean): SearchObject | null {
  if (gmail && typeof criteria.gmailRaw === "string" && criteria.gmailRaw !== "") return { gmraw: criteria.gmailRaw };
  const query = plainSearchObject(criteria);
  const negated = (criteria.not ?? []).map(plainSearchObject).filter((entry) => Object.keys(entry).length > 0);
  if (negated.length === 1) query.not = negated[0]!;
  else if (negated.length > 1) query.not = { or: negated };
  return Object.keys(query).length > 0 ? query : null;
}

/** X-GM-LABELS of a fetched message as a list, or undefined when the server sent none. */
function labelsOf(message: Pick<FetchMessageObject, "labels">): string[] | undefined {
  return message.labels instanceof Set ? [...message.labels] : undefined;
}

/** What a watch needs from an imapflow client; tests pass a stub. Nothing here writes. */
export type WatchClient = Pick<
  ImapFlow,
  "connect" | "capabilities" | "enabled" | "mailbox" | "usable" | "mailboxOpen" | "idle" | "logout" | "close" | "on"
>;

/** Longest wait for LOGOUT when a watch is aborted; then the socket is closed. */
export const WATCH_LOGOUT_CAP_MS = 2_000;

/** Login refusals that are the server's passing reason, not the credentials (describeImapError). */
const THROTTLED_CODES = new Set(["LoginThrottled", "UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG", "ALERT"]);

const dropped = (error: unknown): WatchEnd => {
  const mapped = describeImapError(error);
  return { kind: "dropped", code: mapped instanceof SafeImapError ? mapped.code : "Unknown" };
};

/**
 * One IDLE watch on `client` (spec "IMAP IDLE" with resolutions 15 and 25):
 * connect, EXAMINE `path`, IDLE until the signal aborts or the connection
 * ends. Calls only connect, mailboxOpen (read-only), idle, logout and close;
 * event payloads are read for counts only. Never rejects.
 */
export async function runWatch(
  client: WatchClient,
  path: string,
  onChange: (change: "exists" | "expunge" | "flags") => void,
  signal: AbortSignal,
  log: (line: string) => void = () => {},
): Promise<WatchEnd> {
  let settled: WatchEnd | null = null;
  let resolveEnd!: (end: WatchEnd) => void;
  const ended = new Promise<WatchEnd>((resolve) => {
    resolveEnd = resolve;
  });
  /** Set once the abort began: only "aborted" settles the watch from then on. */
  let stopping = false;
  const finish = (end: WatchEnd) => {
    if (settled !== null || (stopping && end.kind !== "aborted")) return;
    settled = end;
    resolveEnd(end);
  };
  const notify = (change: "exists" | "expunge" | "flags") => {
    if (settled !== null || stopping) return;
    try {
      onChange(change);
    } catch {
      // A broken listener must not end the watch.
    }
  };

  let lastErrorCode: string | null = null;
  // An unhandled 'error' event would crash the host process.
  client.on("error", (error: unknown) => {
    const end = dropped(error);
    lastErrorCode = end.kind === "dropped" ? end.code : null;
    log(`imap watch error: ${lastErrorCode ?? "Unknown"}`);
    finish(end);
  });
  client.on("close", () => finish({ kind: "dropped", code: lastErrorCode ?? "ConnectionClosed" }));
  client.on("exists", (data: unknown) => {
    const { count, prevCount } = (data ?? {}) as { count?: unknown; prevCount?: unknown };
    if (typeof count === "number" && typeof prevCount === "number" && count > prevCount) notify("exists");
  });
  client.on("expunge", () => notify("expunge"));
  client.on("flags", () => notify("flags"));

  let closed = false;
  const shutDown = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WATCH_LOGOUT_CAP_MS);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (client.usable) client.logout().then(done, done);
      else done();
    });
    try {
      client.close();
    } catch {
      // Already closed.
    }
  };

  const onAbort = () => {
    if (settled !== null) return;
    stopping = true;
    void shutDown().then(() => finish({ kind: "aborted" }));
  };

  /** null once stopping: onAbort settles the watch itself, after the logout. */
  async function run(): Promise<WatchEnd | null> {
    if (stopping) return null;
    try {
      await client.connect();
    } catch (error) {
      const mapped = describeImapError(error);
      if (mapped instanceof ImapAuthError) return { kind: "auth" };
      if (mapped instanceof SafeImapError && THROTTLED_CODES.has(mapped.code)) return { kind: "throttled" };
      return dropped(mapped);
    }
    if (stopping) return null;
    if (!supportsIdle(client)) return { kind: "unsupported" };
    try {
      await client.mailboxOpen(path, { readOnly: true });
    } catch (error) {
      return dropped(error);
    }
    while (!stopping && client.usable) {
      const answer = await client.idle();
      if (stopping || settled !== null) return null;
      // imapflow resolves false when the server answers IDLE with NO or BAD
      // (and when the connection failed under it): end, never spin.
      if (answer === false) {
        return client.usable ? { kind: "dropped", code: IDLE_REFUSED_CODE } : { kind: "dropped", code: lastErrorCode ?? "ConnectionClosed" };
      }
      // idle() returns at once when no mailbox is selected: end rather than spin.
      if (!client.mailbox) return { kind: "dropped", code: "NoMailboxSelected" };
    }
    return { kind: "dropped", code: lastErrorCode ?? "ConnectionClosed" };
  }

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  run().then(
    (end) => {
      if (end !== null) finish(end);
    },
    (error: unknown) => finish(dropped(error)),
  );
  const end = await ended;
  signal.removeEventListener("abort", onAbort);
  if (end.kind !== "aborted") await shutDown();
  return end;
}

/** IDLE advertised, or IMAP4rev2 active (IDLE is folded into it). */
function supportsIdle(client: Pick<WatchClient, "capabilities" | "enabled">): boolean {
  const capabilities = client.capabilities;
  if (capabilities?.has("IDLE")) return true;
  return (
    client.enabled?.has("IMAP4REV2") === true ||
    (capabilities?.has("IMAP4rev2") === true && !capabilities.has("IMAP4rev1"))
  );
}

/**
 * CREATE `name` (imapflow also SUBSCRIBEs it). imapflow answers an
 * ALREADYEXISTS refusal with `created: false`; any other refusal, or no
 * answer at all, is SafeImapError "CreateFailed" (never the server's text).
 */
export async function createFolderWith(
  client: Pick<ImapFlow, "mailboxCreate">,
  name: string,
): Promise<{ path: string; created: boolean }> {
  let result: Awaited<ReturnType<ImapFlow["mailboxCreate"]>> | undefined;
  try {
    result = await client.mailboxCreate(name);
  } catch (error) {
    const mapped = describeImapError(error);
    throw mapped instanceof ImapAuthError ? mapped : new SafeImapError("CreateFailed");
  }
  if (!result || typeof result.path !== "string") throw new SafeImapError("CreateFailed");
  return { path: result.path, created: result.created !== false };
}

/**
 * A folder session over an open client. A refused SEARCH or STORE throws
 * (never reads as "no messages" or "done"); a message postal-mime cannot
 * parse is kept with its envelope only, so one crafted email cannot block a
 * batch.
 */
export function createSession(
  client: SessionClient,
  readOnly: boolean,
  parse: ParseMail = parseMail,
): FolderSession {
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        throw describeImapError(error);
      }
    };

  /** imapflow 2.11 sends `headers: [...]` as BODY.PEEK[HEADER.FIELDS (...)] by UID. */
  async function fetchHeaderBlocks(uids: number[], fields: readonly string[]) {
    if (uids.length === 0) return [];
    const found: { uid: number; block: Uint8Array }[] = [];
    for await (const message of client.fetch(uids, { uid: true, headers: [...fields] }, { uid: true })) {
      if (!message.headers) continue;
      found.push({ uid: message.uid, block: new Uint8Array(message.headers) });
    }
    return found;
  }

  const isGmail = () => client.capabilities?.has("X-GM-EXT-1") === true;

  async function fetchLabelsOf(uids: number[]): Promise<{ uid: number; labels: string[] }[]> {
    if (uids.length === 0 || !isGmail()) return [];
    const found: { uid: number; labels: string[] }[] = [];
    for await (const message of client.fetch(uids, LABELS_QUERY, { uid: true })) {
      found.push({ uid: message.uid, labels: labelsOf(message) ?? [] });
    }
    return found;
  }

  return {
    status: guarded(async () => {
      const mailbox = client.mailbox;
      if (!mailbox) throw new SafeImapError("NoMailboxSelected");
      return {
        uidValidity: Number(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
      };
    }),

    searchSince: guarded(async (date: Date) => {
      return searchUids(client, { since: date });
    }),

    uidsAfter: guarded(async (uid: number) => {
      // "N:*" always matches the highest uid, even when it is below N.
      const uids = await searchUids(client, { uid: `${uid + 1}:*` });
      return uids.filter((found) => found > uid);
    }),

    fetchMessages: guarded(async (uids: number[]) => {
      if (uids.length === 0) return [];
      const messages: FetchedMessage[] = [];
      const query = isGmail() ? { ...MESSAGE_QUERY, labels: true } : MESSAGE_QUERY;
      for await (const message of client.fetch(uids, query, { uid: true })) {
        let parsed: Email;
        try {
          parsed = await parse(message.source ?? "");
        } catch {
          parsed = EMPTY_MAIL;
        }
        messages.push(toFetchedMessage(message, parsed));
      }
      return messages;
    }),

    fetchListHeaders: guarded((uids: number[]) => fetchHeaderBlocks(uids, LIST_HEADER_FIELDS)),

    fetchHeaderFields: guarded((uids: number[], fields: readonly string[]) => fetchHeaderBlocks(uids, fields)),

    fetchFlags: guarded(async (uids: number[]) => {
      if (uids.length === 0) return [];
      const flags: { uid: number; seen: boolean; flagged: boolean; gmMsgId: string | null; labels?: string[] }[] =
        [];
      const query = isGmail() ? { ...FLAGS_QUERY, labels: true } : FLAGS_QUERY;
      for await (const message of client.fetch(uids, query, { uid: true })) {
        const labels = labelsOf(message);
        flags.push({
          uid: message.uid,
          seen: message.flags?.has("\\Seen") ?? false,
          flagged: message.flags?.has("\\Flagged") ?? false,
          gmMsgId: nonEmpty(message.emailId),
          ...(labels === undefined ? {} : { labels }),
        });
      }
      return flags;
    }),

    markSeen: guarded(async (uids: number[]) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      if (uids.length === 0) return;
      const stored = await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      if (!stored) throw new SafeImapError("StoreFailed");
    }),

    setFlags: guarded(async (uids: number[], change: FlagChange) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      if (uids.length === 0) return;
      const stores: [flag: string, add: boolean | undefined][] = [
        ["\\Seen", change.seen],
        ["\\Flagged", change.flagged],
      ];
      for (const [flag, add] of stores) {
        if (add === undefined) continue;
        // imapflow resolves false when the server refuses the STORE.
        const stored = add
          ? await client.messageFlagsAdd(uids, [flag], { uid: true })
          : await client.messageFlagsRemove(uids, [flag], { uid: true });
        if (!stored) throw new SafeImapError("StoreFailed");
      }
    }),

    fetchRaw: guarded(async (uid: number, maxBytes: number) => {
      // No part: imapflow downloads `source`, which it always asks as
      // BODY.PEEK[]<start.len>, so \Seen is never set. Its own maxBytes only
      // truncates quietly; one byte over the cap lets it stop pulling chunks
      // while this code still sees the overflow and refuses.
      const download = await client.download(String(uid), undefined, { uid: true, maxBytes: maxBytes + 1 });
      const content = download.content;
      if (!content) throw new SafeImapError("NotFound");
      if ((download.meta.expectedSize ?? 0) > maxBytes) {
        content.destroy();
        throw new SafeImapError("TooLarge");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for await (const chunk of content as AsyncIterable<Buffer | string>) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          total += bytes.byteLength;
          if (total > maxBytes) throw new SafeImapError("TooLarge");
          chunks.push(bytes);
        }
      } finally {
        if (!content.destroyed) content.destroy();
      }
      const raw = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return raw;
    }),

    moveMessages: guarded(async (uids: number[], destination: string) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      if (uids.length === 0) return { moved: new Map<number, number>() };
      // Without MOVE imapflow falls back to COPY + \Deleted + EXPUNGE; without
      // UIDPLUS that EXPUNGE is a plain one that also permanently deletes every
      // other \Deleted message in the folder. Such servers get no move at all.
      // Task 4 (sync) must treat MoveUnsupported as an immediate cancel of the
      // pending move, not as a refusal counted toward the 3-strikes limit.
      if (!canMoveSafely(client)) throw new SafeImapError("MoveUnsupported");
      // imapflow resolves false when the server refuses (MOVE, or COPY/EXPUNGE
      // without the MOVE extension) and undefined when it could not even try;
      // it does the same when the connection dropped mid-command. That is not
      // a refusal: sync leaves the move pending without counting a strike.
      const result = await client.messageMove(uids, destination, { uid: true });
      if (!result && client.usable === false) throw new SafeImapError("ConnectionLost");
      if (!result) throw new SafeImapError("MoveFailed");
      if (!(result.uidMap instanceof Map)) return { moved: null };
      const moved = new Map<number, number>();
      for (const [from, to] of result.uidMap) moved.set(Number(from), Number(to));
      return { moved };
    }),

    // UID COPY, used only by undo of an archive on Gmail (slice 3d): it adds
    // the message to `destination` and removes nothing.
    copyMessages: guarded(async (uids: number[], destination: string) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      if (uids.length === 0) return { copied: new Map<number, number>() };
      // imapflow resolves false when the server refuses the COPY (and when the
      // connection dropped mid-command), undefined when it could not try.
      const result = await client.messageCopy(uids, destination, { uid: true });
      if (!result && client.usable === false) throw new SafeImapError("ConnectionLost");
      if (!result) throw new SafeImapError("CopyFailed");
      if (!(result.uidMap instanceof Map)) return { copied: null };
      const copied = new Map<number, number>();
      for (const [from, to] of result.uidMap) copied.set(Number(from), Number(to));
      return { copied };
    }),

    capabilities: () => ({
      uidplus: client.capabilities?.has("UIDPLUS") === true,
      gmail: client.capabilities?.has("X-GM-EXT-1") === true,
    }),

    appendMessage: guarded(async (raw: Uint8Array, flags: string[]) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      const path = client.mailbox ? client.mailbox.path : null;
      if (!path) throw new SafeImapError("NoMailboxSelected");
      const result = await client.append(path, Buffer.from(raw), flags);
      if (!result) throw new SafeImapError("AppendFailed");
      // Only an APPENDUID (uid together with uidValidity) identifies our copy;
      // imapflow's sequence-number lookup without it could name another message.
      if (result.uidValidity === undefined || result.uid === undefined) {
        return { uidValidity: null, uid: null };
      }
      return { uidValidity: Number(result.uidValidity), uid: result.uid };
    }),

    findByMessageId: guarded(async (messageId: string) => {
      const wanted = normalizeMessageId(messageId);
      if (wanted === "") return [];
      // SEARCH HEADER is a substring match: the hits are checked exactly.
      const candidates = await searchUids(client, { header: { "message-id": wanted } });
      if (candidates.length === 0) return [];
      const found: number[] = [];
      for await (const message of client.fetch(candidates, GUARD_QUERY, { uid: true })) {
        const id = message.envelope?.messageId;
        if (typeof id === "string" && normalizeMessageId(id) === wanted) found.push(message.uid);
      }
      return found.sort((a, b) => a - b);
    }),

    expungeOwn: guarded(async (uid: number, guard: { messageId: string; size: number }) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      // Without UIDPLUS imapflow would send a plain EXPUNGE, which removes every
      // \Deleted message of the folder: refuse before any command.
      if (client.capabilities?.has("UIDPLUS") !== true) throw new SafeImapError("ExpungeUnsupported");
      if (!Number.isInteger(uid) || uid <= 0) throw new SafeImapError("GuardMismatch");
      const wanted = normalizeMessageId(guard.messageId);
      let matched = false;
      for await (const message of client.fetch(String(uid), GUARD_QUERY, { uid: true })) {
        if (message.uid !== uid) continue;
        const id = message.envelope?.messageId;
        matched =
          wanted !== "" &&
          typeof id === "string" &&
          normalizeMessageId(id) === wanted &&
          message.size === guard.size;
      }
      if (!matched) throw new SafeImapError("GuardMismatch");
      // imapflow: STORE +FLAGS \Deleted, then UID EXPUNGE <uid> (UIDPLUS).
      const removed = await client.messageDelete(String(uid), { uid: true });
      if (!removed) {
        // Never leave our \Deleted behind without its expunge.
        await client.messageFlagsRemove(String(uid), ["\\Deleted"], { uid: true }).catch(() => false);
        throw new SafeImapError("ExpungeFailed");
      }
    }),

    // Read-only UID SEARCH by Mail's criteria (slice 3h); the newest uids, newest first.
    searchServer: guarded(async (criteria: ServerCriteria) => {
      const query = toSearchObject(criteria, isGmail());
      if (query === null) return [];
      const uids = await searchUids(client, query);
      return [...new Set(uids)].sort((a, b) => b - a).slice(0, SERVER_SEARCH_CAPS.uidsPerFolder);
    }),

    fetchLabels: guarded(fetchLabelsOf),

    // STORE +X-GM-LABELS / -X-GM-LABELS (Gmail, read-write), then what the server now reports.
    setLabels: guarded(async (uids: number[], change: { add: string[]; remove: string[] }) => {
      if (readOnly) throw new SafeImapError("ReadOnly", "IMAP error (mailbox is read-only)");
      if (!isGmail()) throw new SafeImapError("LabelsRefused");
      if (uids.length === 0) return [];
      // imapflow resolves false when the server refuses the STORE (commands/store.js).
      if (change.add.length > 0) {
        const added = await client.messageFlagsAdd(uids, change.add, { uid: true, useLabels: true });
        if (!added) throw new SafeImapError("LabelsRefused");
      }
      if (change.remove.length > 0) {
        const removed = await client.messageFlagsRemove(uids, change.remove, { uid: true, useLabels: true });
        if (!removed) throw new SafeImapError("LabelsRefused");
      }
      return fetchLabelsOf(uids);
    }),
    close: () => logoutQuietly(client),
  };
}

/**
 * MOVE, or UIDPLUS (imapflow's fallback then runs UID EXPUNGE on the moved
 * uids only). Both are part of IMAP4rev2, which counts when it is active the
 * way imapflow decides it (enabled, or rev2 advertised without rev1).
 */
function canMoveSafely(client: Pick<SessionClient, "capabilities" | "enabled">): boolean {
  const capabilities = client.capabilities;
  if (capabilities?.has("MOVE") || capabilities?.has("UIDPLUS")) return true;
  const rev2Active =
    client.enabled?.has("IMAP4REV2") === true ||
    (capabilities?.has("IMAP4rev2") === true && !capabilities.has("IMAP4rev1"));
  return rev2Active;
}

/** LIST (with imapflow's special-use resolution, incl. its name fallback) mapped to RemoteFolder. */
export async function listRemoteFolders(client: Pick<ImapFlow, "list">): Promise<RemoteFolder[]> {
  try {
    return toRemoteFolders(await client.list());
  } catch (error) {
    throw describeImapError(error);
  }
}

async function searchUids(
  client: SessionClient,
  query: Parameters<ImapFlow["search"]>[0],
): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  // imapflow resolves false when the server refuses the SEARCH.
  if (!Array.isArray(result)) throw new SafeImapError("SearchFailed");
  return result;
}

async function logoutQuietly(client: Pick<ImapFlow, "logout" | "close">): Promise<void> {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

/** imapflow options for a config: TLS on every port, no library logging, bounded timeouts. */
export function toImapflowOptions(config: ImapConfig, accessToken: string | null = null): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: true,
    // A Google account signs in with an access token (XOAUTH2); its refresh token never reaches imapflow.
    auth: accessToken !== null ? { user: config.user, accessToken } : { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    // Bounded waits, so a silent server cannot hold a sync round (or shutdown) for minutes.
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

/**
 * RFC 5530 codes (and ALERT, which Gmail sends when throttling) for a login
 * the server refused for its own, passing reason: the credentials may be
 * fine, so the account must keep retrying.
 */
const TRANSIENT_LOGIN_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG", "ALERT"]);

/** Codes that say the credentials themselves were refused, whatever the text adds. */
const CREDENTIAL_CODES = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
  "EXPIRED",
  "PRIVACYREQUIRED",
  "CONTACTADMIN",
]);

/**
 * Words of a throttled login (Gmail: "Too many simultaneous connections").
 * imapflow flags any tagged NO to LOGIN as authenticationFailed, so the reply
 * text is read to classify it, and only that: it is never logged or passed on.
 */
const THROTTLED_LOGIN = /too many|simultaneous|\brate\b|rate[- ]?limit|throttl|try again|temporar/i;

function loginThrottled(fields: { serverResponseCode?: unknown; response?: unknown; responseText?: unknown }): boolean {
  if (typeof fields.serverResponseCode === "string" && CREDENTIAL_CODES.has(fields.serverResponseCode)) {
    return false;
  }
  return [fields.response, fields.responseText].some(
    (text) => typeof text === "string" && THROTTLED_LOGIN.test(text),
  );
}

/**
 * A safe error for anything imapflow throws: ImapAuthError for a rejected
 * login (stops the account until the password changes), a retryable
 * SafeImapError for a transient refusal, otherwise an Error whose message
 * names only a code.
 */
export function describeImapError(error: unknown): Error {
  if (error instanceof ImapAuthError || error instanceof SafeImapError) return error;
  const fields = (error ?? {}) as {
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    response?: unknown;
    responseText?: unknown;
    code?: unknown;
    tlsFailed?: unknown;
  };
  // imapflow's own refusal to sign in (the connection closed first, the server
  // offers no login): the server never judged the password.
  if (error instanceof AuthenticationFailure && fields.response === undefined && fields.serverResponseCode === undefined) {
    return new SafeImapError(error.message === "Already logged out" ? "NoConnection" : "LoginUnavailable");
  }
  if (
    typeof fields.serverResponseCode === "string" &&
    TRANSIENT_LOGIN_CODES.has(fields.serverResponseCode)
  ) {
    return new SafeImapError(fields.serverResponseCode);
  }
  if (fields.authenticationFailed === true && loginThrottled(fields)) {
    return new SafeImapError("LoginThrottled");
  }
  if (fields.authenticationFailed === true || fields.serverResponseCode === "AUTHENTICATIONFAILED") {
    return new ImapAuthError();
  }
  if (typeof fields.code === "string" && SAFE_CODE.test(fields.code)) {
    return new SafeImapError(fields.code);
  }
  if (fields.tlsFailed === true) return new SafeImapError("TLSFailed", "IMAP error (TLS failed)");
  return new SafeImapError("Unknown", "IMAP error");
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Envelope fields first, postal-mime headers as the fallback. The date falls
 * back to INTERNALDATE, so it is null only when both are missing or invalid.
 * Attachments carry metadata only; partId is the 1-based position in
 * postal-mime's attachment list, unique per message.
 */
export function toFetchedMessage(message: FetchMessageObject, parsed: Email): FetchedMessage {
  const envelope = message.envelope;
  const fromList = envelope?.from?.length
    ? envelope.from.map(fromImapflow)
    : flatten(parsed.from ? [parsed.from] : []);
  return {
    uid: message.uid,
    messageId: nonEmpty(envelope?.messageId) ?? nonEmpty(parsed.messageId),
    inReplyTo: nonEmpty(envelope?.inReplyTo) ?? nonEmpty(parsed.inReplyTo),
    references: splitReferences(parsed.references),
    gmThreadId: nonEmpty(message.threadId),
    gmMsgId: nonEmpty(message.emailId),
    date: toIso(envelope?.date) ?? toIso(message.internalDate),
    from: fromList[0] ?? { name: null, address: "" },
    to: envelope?.to ? envelope.to.map(fromImapflow) : flatten(parsed.to ?? []),
    cc: envelope?.cc ? envelope.cc.map(fromImapflow) : flatten(parsed.cc ?? []),
    // From the parsed headers: the ENVELOPE reply-to defaults to From, so
    // only the raw header tells a real Reply-To apart.
    replyTo: flatten(parsed.replyTo ?? []),
    subject: envelope?.subject ?? parsed.subject ?? "",
    seen: message.flags?.has("\\Seen") ?? false,
    flagged: message.flags?.has("\\Flagged") ?? false,
    size: message.size ?? message.source?.length ?? 0,
    bodyText: parsed.text ?? null,
    bodyHtml: parsed.html ?? null,
    attachments: parsed.attachments.map(
      (attachment, index): AttachmentMeta => ({
        partId: String(index + 1),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: contentSize(attachment.content),
        isInline: attachment.disposition === "inline" || attachment.related === true,
      }),
    ),
    inlineParts: toInlineParts(parsed.attachments),
    bulkHeaders: toBulkHeaders(parsed),
    deliveredTo: toDeliveredTo(parsed),
    unsubscribeHeaders: toUnsubscribeHeaders(parsed),
    devHeaders: toDevHeaders(parsed),
    ...toSecurityFields(parsed),
    ...(message.labels instanceof Set ? { gmLabels: [...message.labels] } : {}),
  };
}

const DEV_NAMES = new Set(DEV_HEADER_FIELDS.map((name) => name.toLowerCase()));
/** Dev header lines kept per message. */
const DEV_HEADERS_MAX = 16;

/**
 * The DEV_HEADER_FIELDS lines of the parsed source (slice 3g), lower-case
 * keys, at most 16; absent when the source had no headers.
 */
function toDevHeaders(parsed: Email): HeaderLine[] | undefined {
  if (parsed.headers.length === 0) return undefined;
  const out: HeaderLine[] = [];
  for (const header of parsed.headers) {
    if (!DEV_NAMES.has(header.key.toLowerCase())) continue;
    out.push({ key: header.key.toLowerCase(), value: header.value });
    if (out.length >= DEV_HEADERS_MAX) break;
  }
  return out;
}

const UNSUBSCRIBE_NAMES = new Set(UNSUBSCRIBE_HEADER_FIELDS.map((name) => name.toLowerCase()));
const TRACE_PREFIXES = [
  ...new Set(
    Object.values(PROVIDER_TRACE_HEADERS)
      .flat()
      .filter((name) => name.endsWith("*"))
      .map((name) => name.slice(0, -1).toLowerCase()),
  ),
];

/**
 * The header lines unsubscribe parsing reads (slice 3e): the
 * UNSUBSCRIBE_HEADER_FIELDS names and the providers' trace names (prefix
 * ones included), in message order, values as postal-mime unfolded them,
 * capped by capHeaderLines (64 lines, then the list headers past the cap and
 * the truncation mark; review item 2); absent when the source had no
 * headers, so the stored info stays.
 */
function toUnsubscribeHeaders(parsed: Email): HeaderLine[] | undefined {
  if (parsed.headers.length === 0) return undefined;
  const out: HeaderLine[] = [];
  for (const header of parsed.headers) {
    // postal-mime keeps whitespace in a key (" From" is not From): never trim it.
    const key = header.key.toLowerCase();
    if (!UNSUBSCRIBE_NAMES.has(key) && !TRACE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out.push({ key, value: header.value });
  }
  return capHeaderLines(out);
}

/** The top Content-Type kept for the crypto check, at most this many characters. */
const CONTENT_TYPE_MAX = 2_048;

/**
 * Slice 3i (resolution 16): whether the message asks for a read receipt and
 * its top Content-Type, as separate fields; the kept unsubscribe lines are
 * not touched, so trustOf's block end and the 64-line cap stay as they are.
 * Both absent when the source had no headers.
 */
function toSecurityFields(parsed: Email): Pick<FetchedMessage, "receiptRequested" | "contentType"> {
  if (parsed.headers.length === 0) return {};
  const contentType = parsed.headers.find((header) => header.key.toLowerCase() === "content-type")?.value ?? null;
  return {
    receiptRequested: receiptRequested(parsed.headers),
    contentType: contentType === null ? null : contentType.slice(0, CONTENT_TYPE_MAX),
  };
}

/** Delivered-To / X-Original-To addresses kept per message (slice 3d). */
const DELIVERED_TO_MAX = 10;

/**
 * Every Delivered-To and X-Original-To header of the parsed source (the
 * address only, lower case, at most 10); absent when the source had no
 * headers, so the store keeps what it knew.
 */
function toDeliveredTo(parsed: Email): string[] | undefined {
  if (parsed.headers.length === 0) return undefined;
  const out: string[] = [];
  for (const header of parsed.headers) {
    if (header.key !== "delivered-to" && header.key !== "x-original-to") continue;
    const value = header.value.trim();
    const open = value.lastIndexOf("<");
    const close = value.lastIndexOf(">");
    const address = (open >= 0 && close > open ? value.slice(open + 1, close) : value).trim().toLowerCase();
    if (address === "" || /\s/.test(address) || !address.includes("@")) continue;
    if (!out.includes(address)) out.push(address);
    if (out.length >= DELIVERED_TO_MAX) break;
  }
  return out;
}

/**
 * The bulk headers, from the source MESSAGE_QUERY already fetches with
 * BODY.PEEK[] (no extra fetch item, never \Seen). A source that did not parse
 * has no headers: the mark stays unknown.
 */
function toBulkHeaders(parsed: Email): BulkHeaders | undefined {
  if (parsed.headers.length === 0) return undefined;
  const first = (key: string) => parsed.headers.find((header) => header.key === key)?.value ?? null;
  return {
    listId: first("list-id"),
    listUnsubscribe: first("list-unsubscribe"),
    precedence: first("precedence"),
    autoSubmitted: first("auto-submitted"),
  };
}

const SPECIAL_USE: Record<string, SpecialUse> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\junk": "junk",
  "\\trash": "trash",
  "\\archive": "archive",
  "\\all": "all",
};

/** Gmail's \Flagged (Starred) and \Important folders only repeat mail held elsewhere. */
const VIRTUAL_FOLDER_FLAGS = new Set(["\\flagged", "\\important"]);
const NOT_SELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

/**
 * Folders as the server lists them, in listing order. Entries LIST did not
 * report (LSUB-only) and Gmail's virtual folders are left out; special use
 * comes from imapflow (SPECIAL-USE/XLIST flags, else its name fallback), and
 * INBOX in any case is always the Inbox.
 */
export function toRemoteFolders(entries: ListResponse[]): RemoteFolder[] {
  const folders: RemoteFolder[] = [];
  for (const entry of entries) {
    if (entry.listed === false) continue;
    const flags = new Set([...(entry.flags ?? [])].map((flag) => flag.toLowerCase()));
    if ([...flags].some((flag) => VIRTUAL_FOLDER_FLAGS.has(flag))) continue;
    const specialUse =
      entry.path.toUpperCase() === "INBOX"
        ? "inbox"
        : (SPECIAL_USE[(entry.specialUse ?? "").toLowerCase()] ?? null);
    folders.push({
      path: entry.path,
      name: entry.name || entry.path,
      delimiter: entry.delimiter ?? "",
      specialUse,
      selectable: ![...flags].some((flag) => NOT_SELECTABLE_FLAGS.has(flag)),
      // Servers without LSUB / LIST-EXTENDED leave it unset: every folder counts as subscribed.
      subscribed: entry.subscribed ?? true,
    });
  }
  return folders;
}

/**
 * Inline image parts a message's HTML can reference by `cid:`: image parts
 * with a Content-ID (brackets stripped), capped per part and per message by
 * the store rules. Anything unusable is skipped; this never throws.
 */
export function toInlineParts(attachments: Attachment[]): InlinePart[] {
  const parts: InlinePart[] = [];
  for (const attachment of attachments) {
    try {
      const part = toInlinePart(attachment);
      if (part) parts.push(part);
    } catch {
      // A malformed part is dropped; the image shows as broken.
    }
  }
  return capInlineParts(parts);
}

function toInlinePart(attachment: Attachment): InlinePart | null {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.toLowerCase() : "";
  if (!mimeType.startsWith("image/")) return null;
  const contentId =
    typeof attachment.contentId === "string" ? attachment.contentId.trim().replace(/^<|>$/g, "").trim() : "";
  if (contentId === "") return null;
  const content = attachment.content;
  let data: Uint8Array;
  if (content instanceof Uint8Array) data = content.slice();
  else if (content instanceof ArrayBuffer) data = new Uint8Array(content.slice(0));
  else return null;
  return { contentId, mimeType, data };
}

function fromImapflow(address: MessageAddressObject): MailAddress {
  return { name: nonEmpty(address.name), address: address.address ?? "" };
}

function flatten(addresses: Address[]): MailAddress[] {
  return addresses.flatMap((entry) =>
    entry.group
      ? entry.group.map((member) => ({ name: nonEmpty(member.name), address: member.address }))
      : [{ name: nonEmpty(entry.name), address: entry.address ?? "" }],
  );
}

function splitReferences(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(/[\s,]+/)
    .flatMap((token) => token.split("><").map((part, i, all) => {
      if (all.length === 1) return part;
      return (i > 0 ? "<" : "") + part + (i < all.length - 1 ? ">" : "");
    }))
    .filter((id) => id !== "");
}

function toIso(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function contentSize(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === "string" ? content.length : content.byteLength;
}
