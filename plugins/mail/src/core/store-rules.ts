// Rules every MailStore applies the same way (the SQLite store and the
// in-memory test store): cross-folder identity, inline image caps, Inbox
// detection and folder order.
import type { InlinePart, SpecialUse } from "./model.ts";

/** Largest inline image part kept. */
export const INLINE_PART_MAX_BYTES = 512 * 1024;
/** Most inline image bytes kept per message. */
export const INLINE_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Identity of a message across folders: Gmail X-GM-MSGID, else Message-ID,
 * else the row itself.
 */
export function dedupKeyOf(gmMsgId: string | null, messageId: string | null, rowId: string): string {
  if (gmMsgId !== null) return `gm:${gmMsgId}`;
  if (messageId !== null) return `mid:${messageId}`;
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
