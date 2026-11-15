// Rules every MailStore applies the same way (the SQLite store and the
// in-memory test store): cross-folder identity, inline image caps, Inbox
// detection and folder order.
import type { InlinePart, SpecialUse } from "./model.ts";

/** Largest inline image part kept. */
export const INLINE_PART_MAX_BYTES = 512 * 1024;
/** Most inline image bytes kept per message. */
export const INLINE_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Identity of a message across folders: Gmail X-GM-MSGID, else Message-ID
 * with the RFC822 size (two deliveries can share a Message-ID; exact copies
 * in other folders have the same size), else the row itself.
 */
export function dedupKeyOf(
  gmMsgId: string | null,
  messageId: string | null,
  size: number,
  rowId: string,
): string {
  if (gmMsgId !== null) return `gm:${gmMsgId}`;
  if (messageId !== null) return `mid:${messageId}:${size}`;
  return `id:${rowId}`;
}

/**
 * The parts kept for one message, in order: a part over the per-part cap is
 * dropped, and so is any part that would take the message over its total cap
 * (a later, smaller part may still fit). The first part per content id wins.
 */
export function capInlineParts(parts: InlinePart[]): InlinePart[] {
  const kept: InlinePart[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const part of parts) {
    const size = part.data.byteLength;
    if (seen.has(part.contentId) || size > INLINE_PART_MAX_BYTES) continue;
    if (total + size > INLINE_MESSAGE_MAX_BYTES) continue;
    seen.add(part.contentId);
    total += size;
    kept.push(part);
  }
  return kept;
}

/** IMAP's INBOX (case-insensitive by RFC 3501) is the Inbox even without a special-use flag. */
export function effectiveSpecialUse(path: string, specialUse: SpecialUse | null): SpecialUse | null {
  if (specialUse !== null) return specialUse;
  return path.toUpperCase() === "INBOX" ? "inbox" : null;
}

const SYSTEM_ORDER: SpecialUse[] = ["inbox", "sent", "drafts", "junk", "archive", "all", "trash"];

/** System folders first in SYSTEM_ORDER, then the rest by name, then path. */
export function compareFolders(
  a: { path: string; name: string; specialUse: SpecialUse | null },
  b: { path: string; name: string; specialUse: SpecialUse | null },
): number {
  const rank = (f: { specialUse: SpecialUse | null }) =>
    f.specialUse === null ? SYSTEM_ORDER.length : SYSTEM_ORDER.indexOf(f.specialUse);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Roles the All accounts view merges, in display order. All Mail is left
 * out: Gmail's All Mail stays under its account, and Archive merges
 * `archive` folders only.
 */
export const UNIFIED_ROLES: readonly SpecialUse[] = ["inbox", "sent", "drafts", "junk", "archive", "trash"];

/** One address seen in stored mail, for recipient suggestions. */
export type SuggestionEntry = {
  address: string;
  name: string | null;
  /** ISO 8601 date of the message, or null. */
  date: string | null;
  /** A To or Cc address of a message in the owner's Sent folder. */
  ownerSent: boolean;
};

/**
 * Recipient suggestions from stored mail: distinct addresses (case-folded)
 * whose address, or a word of whose display name, starts with the prefix;
 * addresses the owner sent to first, then the most recent, then the most
 * frequent, then by address. The name is the latest non-empty one seen.
 */
export function rankRecipientSuggestions(
  entries: Iterable<SuggestionEntry>,
  prefix: string,
  limit: number,
): { name: string | null; address: string }[] {
  const wanted = prefix.trim().toLowerCase();
  if (wanted === "" || limit <= 0) return [];
  type Tally = {
    address: string;
    name: string | null;
    nameTime: number;
    latest: number;
    count: number;
    ownerSent: boolean;
  };
  const tallies = new Map<string, Tally>();
  for (const entry of entries) {
    const address = entry.address.trim();
    if (!address.includes("@") || /[\s<>,;"\u0000-\u001f]/.test(address)) continue;
    const key = address.toLowerCase();
    const parsed = entry.date === null ? Number.NaN : Date.parse(entry.date);
    const time = Number.isFinite(parsed) ? parsed : -Infinity;
    const name = entry.name?.trim() || null;
    const tally = tallies.get(key);
    if (tally === undefined) {
      tallies.set(key, { address: key, name, nameTime: name === null ? -Infinity : time, latest: time, count: 1, ownerSent: entry.ownerSent });
      continue;
    }
    tally.count++;
    tally.latest = Math.max(tally.latest, time);
    tally.ownerSent ||= entry.ownerSent;
    if (name !== null && (tally.name === null || time >= tally.nameTime)) {
      tally.name = name;
      tally.nameTime = time;
    }
  }
  const matches = (tally: Tally) =>
    tally.address.startsWith(wanted) ||
    (tally.name !== null &&
      tally.name
        .toLowerCase()
        .split(/\s+/)
        .some((word) => word.startsWith(wanted) || word.replace(/^["'(]+/, "").startsWith(wanted)));
  return [...tallies.values()]
    .filter(matches)
    .sort(
      (a, b) =>
        Number(b.ownerSent) - Number(a.ownerSent) ||
        (b.latest === a.latest ? 0 : b.latest > a.latest ? 1 : -1) ||
        b.count - a.count ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    )
    .slice(0, limit)
    .map((tally) => ({ name: tally.name, address: tally.address }));
}
