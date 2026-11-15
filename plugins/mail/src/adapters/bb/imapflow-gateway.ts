// ImapGateway on imapflow. TLS only (secure: true whatever the port, never
// STARTTLS or plaintext), one folder per session, every body fetch is
// BODY.PEEK (imapflow fetches `source` with PEEK, and `download` of the whole
// message fetches `source` in chunks), and the only writes are \Seen on
// owner-opened mail (markSeen), owner-clicked or hotkeyed \Seen / \Flagged
// add/remove (setFlags) and owner-clicked moves (moveMessages).
// Errors leaving this file are rebuilt from codes: imapflow errors can carry
// server responses and the sent command, so their text is never passed on.
import { ImapFlow } from "imapflow";
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MessageAddressObject,
} from "imapflow";
import PostalMime from "postal-mime";
import type { Address, Attachment, Email, RawEmail } from "postal-mime";
import {
  ImapAuthError,
  capInlineParts,
  type AttachmentMeta,
  type FetchedMessage,
  type FlagChange,
  type ImapConfig,
  type ImapGateway,
  type FolderSession,
  type InlinePart,
  type MailAddress,
  type RemoteFolder,
  type SpecialUse,
} from "../../core/index.ts";

export interface ImapflowGatewayOptions {
  /** Receives one safe line per connection error; never message or credential text. */
  logger?: (line: string) => void;
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

  async function connect(config: ImapConfig): Promise<ImapFlow> {
    const client = new ImapFlow(toImapflowOptions(config));
    // An unhandled 'error' event would crash the host process.
    client.on("error", (error: unknown) => log(`imap connection error: ${describeImapError(error).message}`));
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.close();
      throw describeImapError(error);
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
  };
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
      for await (const message of client.fetch(uids, MESSAGE_QUERY, { uid: true })) {
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

    fetchFlags: guarded(async (uids: number[]) => {
      if (uids.length === 0) return [];
      const flags: { uid: number; seen: boolean; flagged: boolean; gmMsgId: string | null }[] =
        [];
      for await (const message of client.fetch(uids, FLAGS_QUERY, { uid: true })) {
        flags.push({
          uid: message.uid,
          seen: message.flags?.has("\\Seen") ?? false,
          flagged: message.flags?.has("\\Flagged") ?? false,
          gmMsgId: nonEmpty(message.emailId),
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

    // Slice 3b server writes; not implemented yet.
    capabilities: () => {
      throw new SafeImapError("NotImplemented");
    },
    appendMessage: async () => {
      throw new SafeImapError("NotImplemented");
    },
    findByMessageId: async () => {
      throw new SafeImapError("NotImplemented");
    },
    expungeOwn: async () => {
      throw new SafeImapError("NotImplemented");
    },
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

async function logoutQuietly(client: SessionClient): Promise<void> {
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
export function toImapflowOptions(config: ImapConfig): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
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
    // Reply-To is not mapped yet; nothing reads it before migration element 4.
    replyTo: [],
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
