// Reply and forward rules: who a reply goes to, its threading headers and the
// plain-text lines above a quote. Pure functions over stored header fields.
import { dedupeAddresses, parseAddress, type OutgoingAddress } from "./compose-address.ts";
import { normalizeMessageId } from "./headers.ts";
import type { MailAddress } from "./model.ts";

/** What a reply or forward needs to know about the original message. */
export type ReplySource = {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  /** ISO 8601, or null when unknown. */
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
};

export type ReplyKind = "reply" | "reply_all";

/** References kept: the first id plus the last this many (RFC 5322 3.6.4 practice). */
const REFERENCES_TAIL = 20;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Reply: Reply-To, else From; for one's own message (From is an address of
 * any account) the original To. Reply all: that target plus the original To,
 * Cc = the original Cc, every own address removed, deduped across both, Cc
 * moved into To when To ends up empty. Bcc is never carried. Addresses that
 * cannot be sent to are left out; domains come back punycoded.
 */
export function replyRecipients(
  source: ReplySource,
  kind: ReplyKind,
  ownAddresses: string[],
): { to: OutgoingAddress[]; cc: OutgoingAddress[] } {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()));
  const isOwn = (address: string) => own.has(address.toLowerCase());
  const fromSelf = own.has(source.from.address.trim().toLowerCase());
  const target = fromSelf
    ? source.to
    : source.replyTo.length > 0
      ? source.replyTo
      : [source.from];

  if (kind === "reply") {
    const to = dedupeAddresses(sendable(target));
    return { to: to.length > 0 ? to : dedupeAddresses(sendable([source.from])), cc: [] };
  }

  const to = dedupeAddresses(sendable([...target, ...source.to])).filter((a) => !isOwn(a.address));
  const inTo = new Set(to.map((a) => a.address.toLowerCase()));
  const cc = dedupeAddresses(sendable(source.cc)).filter(
    (a) => !isOwn(a.address) && !inTo.has(a.address.toLowerCase()),
  );
  return to.length > 0 ? { to, cc } : { to: cc, cc: [] };
}

/** In-Reply-To = the original's Message-ID; References = its References (or In-Reply-To) plus that id. */
export function threadingHeaders(source: ReplySource): {
  inReplyTo: string | null;
  references: string[];
} {
  const messageId = bracketed(source.messageId);
  if (messageId === null) return { inReplyTo: null, references: [] };
  const base = source.references.length > 0
    ? source.references
    : source.inReplyTo !== null
      ? [source.inReplyTo]
      : [];
  const ids: string[] = [];
  for (const raw of [...base, messageId]) {
    const id = bracketed(raw);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  const references = ids.length > REFERENCES_TAIL + 1
    ? [ids[0] as string, ...ids.slice(-REFERENCES_TAIL)]
    : ids;
  return { inReplyTo: messageId, references };
}

/** Plain-text lines above the quoted original: the attribution line, or the forwarded-message block. */
export function quoteHeaderText(source: ReplySource, kind: ReplyKind | "forward"): string[] {
  const date = formatDate(source.date);
  const from = formatAddress(source.from);
  if (kind !== "forward") {
    return [date === null ? `${from} wrote:` : `On ${date}, ${from} wrote:`];
  }
  const lines = ["---------- Forwarded message ----------", `From: ${from}`];
  if (date !== null) lines.push(`Date: ${date}`);
  lines.push(`Subject: ${clean(source.subject)}`);
  if (source.to.length > 0) lines.push(`To: ${source.to.map(formatAddress).join(", ")}`);
  if (source.cc.length > 0) lines.push(`Cc: ${source.cc.map(formatAddress).join(", ")}`);
  return lines;
}

function sendable(list: MailAddress[]): OutgoingAddress[] {
  const kept: OutgoingAddress[] = [];
  for (const entry of list) {
    const parsed = parseAddress(entry.address);
    if (!parsed.ok) continue;
    const name = entry.name === null ? "" : clean(entry.name);
    kept.push({ name: name === "" ? null : name, address: parsed.value.address });
  }
  return kept;
}

/** `<id>`, or null when the id is empty or holds whitespace, controls or brackets. */
function bracketed(raw: string | null): string | null {
  if (raw === null) return null;
  const id = normalizeMessageId(raw);
  if (id === "" || /[\s<>\u0000-\u001f\u007f-\u009f]/.test(id)) return null;
  return `<${id}>`;
}

function clean(text: string): string {
  return text.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
}

function formatAddress(address: MailAddress): string {
  const name = address.name === null ? "" : clean(address.name);
  const mailbox = clean(address.address);
  return name === "" ? mailbox : `${name} <${mailbox}>`;
}

/** "14 Nov 2026 09:05 UTC"; null when the date is missing or unreadable. */
function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
