// Raw-message access for the Details panel and downloads: one-time tickets,
// the stale-uid guard around fetchRaw, safe file names and response headers.
// Bytes, tickets, file names and header values never reach a log line or a
// realtime payload; nothing is written to disk.
import { randomBytes } from "node:crypto";
import {
  ImapAuthError,
  type Clock,
  type ImapGateway,
  type MailStore,
  type RawRef,
  type SecretVault,
  type StoredAccount,
} from "../../core/index.ts";
import { headerValue, normalizeMessageId } from "../../core/headers.ts";
import { FILE_NAME_MAX, NAME_INPUT_MAX, headOf, sanitizeFileName, trimDots } from "../../core/file-names.ts";

// Moved to the core in slice 3g; re-exported so existing imports keep working.
export { sanitizeFileName, safeContentType } from "../../core/file-names.ts";

/** Largest message fetched whole (stored size and bytes read). */
export const RAW_MAX_BYTES = 50 * 1024 * 1024;
/** How long a download ticket stays valid. */
export const TICKET_TTL_MS = 60_000;
/** Most tickets kept at once; the oldest goes first. */
const TICKETS_MAX = 256;

export const STALE_MESSAGE = "The message changed on the server; sync and try again";
export const UNAVAILABLE_MESSAGE =
  "The message is not available on the server right now; sync and try again";
export const TOO_LARGE_MESSAGE = "The message is larger than 50 MB";
export const FETCH_FAILED_MESSAGE = "Could not fetch the message from the server; try again";

/** A ticket is 32 random bytes in base64url. */
const TICKET_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Short-lived, single-use tickets kept in memory. */
export class TicketBook<T> {
  private readonly tickets = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly max = TICKETS_MAX,
  ) {}

  get size(): number {
    return this.tickets.size;
  }

  mint(value: T): string {
    this.prune();
    while (this.tickets.size >= this.max) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { value, expiresAt: this.clock.now().getTime() + TICKET_TTL_MS });
    return ticket;
  }

  /** The ticket's value once; null when it is unknown, used or expired. */
  take(ticket: string): T | null {
    if (!TICKET_FORMAT.test(ticket)) return null;
    const entry = this.tickets.get(ticket);
    if (entry === undefined) return null;
    this.tickets.delete(ticket);
    return this.clock.now().getTime() < entry.expiresAt ? entry.value : null;
  }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [ticket, entry] of this.tickets) {
      if (now >= entry.expiresAt) this.tickets.delete(ticket);
    }
  }
}


/** "YYYY-MM-DD subject.eml" (UTC date), sanitized; "message.eml" when there is neither. */
export function emlFileName(date: string | null, subject: string): string {
  const time = date === null ? NaN : Date.parse(date);
  const day = Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
  // Slashes in a subject are text, not directories.
  const base = `${day} ${headOf(subject, NAME_INPUT_MAX).replace(/[/\\]/g, "-")}`
    .replace(/\s+/g, " ")
    .trim();
  const stem = sanitizeFileName(base, "message");
  const chars = Array.from(stem);
  const room = FILE_NAME_MAX - ".eml".length;
  return `${chars.length > room ? chars.slice(0, room).join("").trimEnd() : stem}.eml`;
}

/** RFC 5987 attr-chars stay; everything else is percent-encoded as UTF-8. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `attachment` with an ASCII fallback name (no quotes or backslashes;
 * `fallback` when that leaves nothing but dots and spaces) and the UTF-8 name.
 */
export function contentDisposition(fileName: string, fallback = "attachment"): string {
  let ascii = Array.from(fileName)
    .map((char) => (/^[\x20-\x7e]$/.test(char) ? char : "_"))
    .join("")
    .replace(/["\\]/g, "");
  if (trimDots(ascii) === "") ascii = fallback;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}


/** Headers every non-download response of the route carries too. */
export const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'",
};

export function downloadHeaders(
  fileName: string,
  contentType: string,
  length: number,
  fallback = "attachment",
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Content-Disposition": contentDisposition(fileName, fallback),
    ...BASE_HEADERS,
  };
}

/** Why a raw fetch was refused; the message is fixed text, safe to show. */
export class RawRefusal extends Error {
  constructor(
    readonly code: "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "RawRefusal";
  }
}

export type RawDeps = {
  store: MailStore;
  gateway: ImapGateway;
  vault: SecretVault;
  vaultReady: () => boolean;
  /** Refusal texts the server owns. */
  messages: { needsKey: string; passwordNeeded: string };
};

/**
 * A stored message that can be fetched raw: attached, not waiting to move,
 * within the size cap, its account usable. Throws RawRefusal otherwise.
 */
export function checkRawRef(deps: RawDeps, messageId: string): { ref: RawRef; account: StoredAccount } {
  const ref = deps.store.rawRef(messageId);
  if (ref === null) {
    if (deps.store.getMessage(messageId) === null) throw new RawRefusal("not_found", "Unknown message");
    throw new RawRefusal("conflict", UNAVAILABLE_MESSAGE);
  }
  if (ref.size > RAW_MAX_BYTES) throw new RawRefusal("conflict", TOO_LARGE_MESSAGE);
  if (!deps.vaultReady()) throw new RawRefusal("conflict", deps.messages.needsKey);
  const account = deps.store.getAccount(ref.accountId);
  if (account === null) throw new RawRefusal("not_found", "Unknown message");
  if (account.authFailed) throw new RawRefusal("conflict", deps.messages.passwordNeeded);
  return { ref, account };
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The whole message from the server through a read-only session (BODY.PEEK,
 * never \Seen), guarded against a stale uid: the folder's UIDVALIDITY must
 * match the stored one, and the bytes must match the stored size (when
 * known) and Message-ID (when stored). Throws RawRefusal.
 */
export async function fetchRawGuarded(
  deps: RawDeps,
  messageId: string,
): Promise<{ ref: RawRef; account: StoredAccount; raw: Uint8Array }> {
  const { ref, account } = checkRawRef(deps, messageId);
  if (ref.uidValidity === null) throw new RawRefusal("conflict", UNAVAILABLE_MESSAGE);
  let raw: Uint8Array;
  try {
    const config = {
      host: account.host,
      port: account.port,
      user: account.username,
      password: deps.vault.open(account.passwordSealed),
    };
    const session = await deps.gateway.openFolder(config, ref.folder, { readOnly: true });
    try {
      const { uidValidity } = await session.status();
      if (uidValidity !== ref.uidValidity) throw new RawRefusal("conflict", STALE_MESSAGE);
      raw = await session.fetchRaw(ref.uid, RAW_MAX_BYTES);
    } finally {
      await session.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof RawRefusal) throw error;
    if (error instanceof ImapAuthError) throw new RawRefusal("conflict", deps.messages.passwordNeeded);
    const code = codeOf(error);
    if (code === "TooLarge") throw new RawRefusal("conflict", TOO_LARGE_MESSAGE);
    if (code === "NotFound") throw new RawRefusal("conflict", STALE_MESSAGE);
    throw new RawRefusal("conflict", FETCH_FAILED_MESSAGE);
  }
  if (ref.size > 0 && raw.byteLength !== ref.size) throw new RawRefusal("conflict", STALE_MESSAGE);
  if (ref.messageId !== null) {
    const fetched = headerValue(raw, "message-id");
    if (fetched === null || normalizeMessageId(fetched) !== normalizeMessageId(ref.messageId)) {
      throw new RawRefusal("conflict", STALE_MESSAGE);
    }
  }
  return { ref, account, raw };
}
