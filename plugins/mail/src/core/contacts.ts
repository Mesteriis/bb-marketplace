// People the owner corresponds with, for agents (mail_contacts) and for the
// sending account of a new proposal. Only header addresses count (From, To,
// Cc); an address written inside a message's text never becomes a contact.
// Bulk mail (mailing lists, newsletters, automated senders) is left out.
import type { BulkHeaders, MailAddress } from "./model.ts";
import { maskSnippetTail, redactSecrets } from "./redact.ts";
import { SNIPPET_LENGTH } from "./snippet.ts";

export type { BulkHeaders };

export const NO_BULK_HEADERS: BulkHeaders = {
  listId: null,
  listUnsubscribe: null,
  precedence: null,
  autoSubmitted: null,
};

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);
const AUTOMATED_EXACT_PREFIX = /^(notifications?|newsletters?|mailerdaemon|postmaster)/;
const AUTOMATED_ANYWHERE = /noreply|donotreply/;

/** A sender whose local part says no person reads it (no-reply, notifications, newsletter, mailer-daemon, postmaster). */
export function isAutomatedAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const base = address.slice(0, at).toLowerCase().split("+")[0]!.replace(/[-_.]/g, "");
  return AUTOMATED_ANYWHERE.test(base) || AUTOMATED_EXACT_PREFIX.test(base);
}

function present(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Bulk: any List-Id or List-Unsubscribe; Precedence bulk, list or junk;
 * Auto-Submitted other than "no" (RFC 3834); or an automated sender.
 */
export function classifyBulk(headers: BulkHeaders, fromAddress: string): boolean {
  if (present(headers.listId) !== null || present(headers.listUnsubscribe) !== null) return true;
  const precedence = present(headers.precedence)?.toLowerCase();
  if (precedence !== undefined && BULK_PRECEDENCE.has(precedence)) return true;
  const autoSubmitted = present(headers.autoSubmitted)?.toLowerCase().match(/^[^\s;(]+/)?.[0];
  if (autoSubmitted !== undefined && autoSubmitted !== "no") return true;
  return isAutomatedAddress(fromAddress);
}

/** A stored row's mark; a row synced before the mark existed (null) is judged by its sender only. */
export function isBulkRow(bulk: boolean | null, fromAddress: string): boolean {
  return bulk ?? isAutomatedAddress(fromAddress);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Most query words a lookup uses (one bit each in a text mask). */
export const CONTACT_QUERY_WORDS = 8;
/** Characters of a body a lookup reads. */
export const CONTACT_BODY_CHARS = 20_000;

function fold(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

function wordsOf(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Distinct lowercase words of a query (letters and digits, ё read as е), at most CONTACT_QUERY_WORDS. */
export function queryWords(query: string): string[] {
  return [...new Set(wordsOf(query))].slice(0, CONTACT_QUERY_WORDS);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bit i is set when some word of the text starts with words[i]. */
export function textMask(text: string, words: readonly string[]): number {
  if (words.length === 0 || text === "") return 0;
  const folded = fold(text);
  let mask = 0;
  words.forEach((word, index) => {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}`, "u").test(folded)) mask |= 1 << index;
  });
  return mask;
}

/** Body characters redacted past the cut, so a secret straddling it is still recognised. */
const CONTACT_REDACT_MARGIN = 512;

/**
 * The text mask of one message: its subject, snippet and the first
 * CONTACT_BODY_CHARS of its body, over redacted text (slice 3f): a word
 * counts only when it matches the raw text and still matches once secrets
 * are hidden, so a contact is never found by a secret in their mail. The
 * redaction runs only for rows the raw text matched.
 */
export function messageTextMask(
  subject: string | null,
  snippet: string | null,
  bodyText: string | null,
  words: readonly string[],
): number {
  const raw = textMask(`${subject ?? ""}\n${snippet ?? ""}\n${(bodyText ?? "").slice(0, CONTACT_BODY_CHARS)}`, words);
  if (raw === 0) return 0;
  const context = subject ?? "";
  const body = redactSecrets((bodyText ?? "").slice(0, CONTACT_BODY_CHARS + CONTACT_REDACT_MARGIN), { context }).text;
  const redacted = [
    redactSecrets(context).text,
    maskSnippetTail(snippet ?? "", context, SNIPPET_LENGTH).text,
    body.slice(0, CONTACT_BODY_CHARS),
  ].join("\n");
  return raw & textMask(redacted, words);
}

/** Newest stored messages a lookup reads. */
export const CONTACT_SCAN = 5000;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** One stored message as a lookup reads it (junk and trash already left out). */
export type ContactMessage = {
  accountId: string;
  /** Identity across folders: a message in several folders counts once. */
  dedupKey: string;
  date: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** The row is in a Sent-role folder. */
  inSent: boolean;
  /** The stored mark; null for rows synced before it existed. */
  bulk: boolean | null;
  /** textMask of the message's subject, snippet and body for the query words. */
  textMask: number;
};

export type Contact = {
  address: string;
  name: string | null;
  /** The owner's address that exchanged mail with them most recently. */
  ownerAccount: string;
  /** Messages the owner sent with them in To or Cc. */
  sentByOwner: number;
  /** Messages they sent the owner. */
  received: number;
  lastDate: string | null;
};

/**
 * One of the owner's accounts with every address that is the owner's on it
 * (its email first, its username when it holds `@`, its active aliases;
 * spec resolution 11).
 */
export type Owner = { id: string; addresses: readonly string[] };

function ownSet(owners: readonly Owner[]): Set<string> {
  return new Set(owners.flatMap((o) => o.addresses.map((a) => a.trim().toLowerCase())));
}

const BAD_ADDRESS = /[\s<>,;"\u0000-\u001f]/;

function addressKey(address: string): string | null {
  const key = address.trim().toLowerCase();
  if (!key.includes("@") || BAD_ADDRESS.test(key)) return null;
  return key;
}

function timeOf(date: string | null): number {
  const parsed = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/** Distinct messages (a copy in another folder adds its Sent flag and text bits), bulk ones out. */
function distinctPersonal(messages: Iterable<ContactMessage>): ContactMessage[] {
  const byKey = new Map<string, ContactMessage>();
  for (const message of messages) {
    const key = `${message.accountId}\u0000${message.dedupKey}`;
    const known = byKey.get(key);
    if (known === undefined) {
      byKey.set(key, { ...message });
      continue;
    }
    known.inSent ||= message.inSent;
    known.textMask |= message.textMask;
    if (message.bulk === true) known.bulk = true;
  }
  return [...byKey.values()].filter((m) => !isBulkRow(m.bulk, m.from.address));
}

type Side = { address: MailAddress; outgoing: boolean };

/** The other people of one message: To and Cc when the owner sent it, else From (and the other recipients). */
function sidesOf(message: ContactMessage, own: ReadonlySet<string>): Side[] {
  const fromKey = addressKey(message.from.address);
  const outgoing = message.inSent || (fromKey !== null && own.has(fromKey));
  const recipients = [...message.to, ...message.cc];
  if (outgoing) return recipients.map((address) => ({ address, outgoing: true }));
  return [message.from, ...recipients].map((address) => ({ address, outgoing: false }));
}

type Tally = {
  address: string;
  name: string | null;
  nameTime: number;
  sent: number;
  received: number;
  latest: number;
  lastDate: string | null;
  total: number;
  mask: number;
  accounts: Map<string, { latest: number; count: number }>;
};

/**
 * Header contacts whose name, address words or exchanged mail match every
 * query word, best first: the most messages the owner sent them, then
 * two-way correspondence, then the most recent, then the most messages, then
 * by address. The owner's addresses, automated addresses, malformed ones and
 * senders of bulk mail the owner never wrote to are left out.
 */
export function rankContacts(
  messages: Iterable<ContactMessage>,
  words: readonly string[],
  owners: readonly Owner[],
  bulkSenders: ReadonlySet<string>,
  limit: number,
): Contact[] {
  if (words.length === 0 || limit <= 0) return [];
  const own = ownSet(owners);
  const emailOf = new Map(owners.map((o) => [o.id, (o.addresses[0] ?? "").trim().toLowerCase()]));
  const tallies = new Map<string, Tally>();
  for (const message of distinctPersonal(messages)) {
    const time = timeOf(message.date);
    const counted = new Set<string>();
    for (const { address, outgoing } of sidesOf(message, own)) {
      const key = addressKey(address.address);
      if (key === null || own.has(key) || counted.has(key)) continue;
      counted.add(key);
      let tally = tallies.get(key);
      if (tally === undefined) {
        tally = { address: key, name: null, nameTime: -Infinity, sent: 0, received: 0, latest: -Infinity, lastDate: null, total: 0, mask: 0, accounts: new Map() };
        tallies.set(key, tally);
      }
      tally.total++;
      if (outgoing) tally.sent++;
      else if (addressKey(message.from.address) === key) tally.received++;
      if (time > tally.latest) {
        tally.latest = time;
        tally.lastDate = message.date;
      }
      const name = address.name?.trim() || null;
      if (name !== null && (tally.name === null || time >= tally.nameTime)) {
        tally.name = name;
        tally.nameTime = time;
      }
      tally.mask |= message.textMask;
      const account = tally.accounts.get(message.accountId) ?? { latest: -Infinity, count: 0 };
      account.latest = Math.max(account.latest, time);
      account.count++;
      tally.accounts.set(message.accountId, account);
    }
  }
  const all = (1 << words.length) - 1;
  const matched = (tally: Tally) => {
    const header = textMask(`${tally.name ?? ""} ${tally.address}`, words);
    return ((header | tally.mask) & all) === all;
  };
  const ownerOf = (tally: Tally): string | null => {
    let best: { id: string; latest: number; count: number } | null = null;
    for (const [id, account] of tally.accounts) {
      if (!emailOf.has(id)) continue;
      if (best === null || account.latest > best.latest || (account.latest === best.latest && account.count > best.count)) {
        best = { id, ...account };
      }
    }
    return best === null ? null : emailOf.get(best.id)!;
  };
  return [...tallies.values()]
    .filter((t) => !isAutomatedAddress(t.address) && !(t.sent === 0 && bulkSenders.has(t.address)))
    .filter(matched)
    .sort(
      (a, b) =>
        b.sent - a.sent ||
        Number(b.received > 0 && b.sent > 0) - Number(a.received > 0 && a.sent > 0) ||
        (b.latest === a.latest ? 0 : b.latest > a.latest ? 1 : -1) ||
        b.total - a.total ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    )
    .flatMap((t) => {
      const ownerAccount = ownerOf(t);
      return ownerAccount === null
        ? []
        : [{ address: t.address, name: t.name, ownerAccount, sentByOwner: t.sent, received: t.received, lastDate: t.lastDate }];
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Sending account
// ---------------------------------------------------------------------------

/** One account's latest personal mail from and to some addresses. */
export type AccountCorrespondence = {
  accountId: string;
  lastReceived: string | null;
  lastSent: string | null;
};

/** Per account (in the owners' order, only those with any), the latest mail received from and sent to the addresses; bulk left out. */
export function correspondenceOf(
  messages: Iterable<ContactMessage>,
  addresses: readonly string[],
  owners: readonly Owner[],
): AccountCorrespondence[] {
  const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()));
  const own = ownSet(owners);
  const latest = new Map<string, { received: number; receivedDate: string | null; sent: number; sentDate: string | null }>();
  for (const message of distinctPersonal(messages)) {
    const time = timeOf(message.date);
    for (const { address, outgoing } of sidesOf(message, own)) {
      const key = addressKey(address.address);
      if (key === null || !wanted.has(key)) continue;
      if (!outgoing && addressKey(message.from.address) !== key) continue;
      const entry = latest.get(message.accountId) ?? { received: -Infinity, receivedDate: null, sent: -Infinity, sentDate: null };
      if (outgoing && (entry.sentDate === null || time > entry.sent)) {
        entry.sent = time;
        entry.sentDate = message.date ?? entry.sentDate;
      }
      if (!outgoing && (entry.receivedDate === null || time > entry.received)) {
        entry.received = time;
        entry.receivedDate = message.date ?? entry.receivedDate;
      }
      latest.set(message.accountId, entry);
    }
  }
  return owners.flatMap((o) => {
    const entry = latest.get(o.id);
    return entry === undefined ? [] : [{ accountId: o.id, lastReceived: entry.receivedDate, lastSent: entry.sentDate }];
  });
}

/**
 * The account a new message to these people goes from: the one that received
 * mail from them most recently, ties to the one that sent to them most
 * recently; null when no existing account has any history with them.
 */
export function pickSendingAccount(
  accounts: readonly { id: string }[],
  history: readonly AccountCorrespondence[],
): string | null {
  const known = new Set(accounts.map((a) => a.id));
  let best: { id: string; received: number; sent: number } | null = null;
  for (const entry of history) {
    if (!known.has(entry.accountId)) continue;
    if (entry.lastReceived === null && entry.lastSent === null) continue;
    const received = entry.lastReceived === null ? -Infinity : timeOf(entry.lastReceived);
    const sent = entry.lastSent === null ? -Infinity : timeOf(entry.lastSent);
    if (best === null || received > best.received || (received === best.received && sent > best.sent)) {
      best = { id: entry.accountId, received, sent };
    }
  }
  return best?.id ?? null;
}
