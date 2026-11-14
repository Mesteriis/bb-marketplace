// ImapGateway on imapflow. TLS only (secure: true whatever the port, never
// STARTTLS or plaintext), INBOX only, every body fetch is BODY.PEEK (imapflow
// fetches `source` with PEEK), and the only write is \Seen in markSeen.
// Errors leaving this file are rebuilt from codes: imapflow errors can carry
// server responses and the sent command, so their text is never passed on.
import { ImapFlow } from "imapflow";
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  MessageAddressObject,
} from "imapflow";
import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";
import {
  ImapAuthError,
  type AttachmentMeta,
  type FetchedMessage,
  type ImapConfig,
  type ImapGateway,
  type InboxSession,
  type MailAddress,
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
};

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
  "mailbox" | "search" | "fetch" | "messageFlagsAdd" | "logout" | "close"
>;

export type ParseMail = (source: Buffer | string) => Promise<Email>;

const EMPTY_MAIL: Email = { headers: [], headerLines: [], attachments: [] };

function parseWithPostalMime(source: Buffer | string): Promise<Email> {
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

    async openInbox(config, { readOnly }) {
      const client = await connect(config);
      try {
        await client.mailboxOpen("INBOX", { readOnly });
      } catch (error) {
        await logoutQuietly(client);
        throw describeImapError(error);
      }
      return createSession(client, readOnly);
    },
  };
}

/**
 * An INBOX session over an open client. A refused SEARCH or STORE throws
 * (never reads as "no messages" or "done"); a message postal-mime cannot
 * parse is kept with its envelope only, so one crafted email cannot block a
 * batch.
 */
export function createSession(
  client: SessionClient,
  readOnly: boolean,
  parse: ParseMail = parseWithPostalMime,
): InboxSession {
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
      const flags: { uid: number; seen: boolean; flagged: boolean }[] = [];
      for await (const message of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
        flags.push({
          uid: message.uid,
          seen: message.flags?.has("\\Seen") ?? false,
          flagged: message.flags?.has("\\Flagged") ?? false,
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

    close: () => logoutQuietly(client),
  };
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

/** imapflow options for a config: TLS on every port, no library logging. */
export function toImapflowOptions(config: ImapConfig): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
  };
}

/**
 * A safe error for anything imapflow throws: ImapAuthError for a rejected
 * login, otherwise an Error whose message names only a code.
 */
export function describeImapError(error: unknown): Error {
  if (error instanceof ImapAuthError || error instanceof SafeImapError) return error;
  const fields = (error ?? {}) as {
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    code?: unknown;
    tlsFailed?: unknown;
  };
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
    date: toIso(envelope?.date) ?? toIso(message.internalDate),
    from: fromList[0] ?? { name: null, address: "" },
    to: envelope?.to ? envelope.to.map(fromImapflow) : flatten(parsed.to ?? []),
    cc: envelope?.cc ? envelope.cc.map(fromImapflow) : flatten(parsed.cc ?? []),
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
  };
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
