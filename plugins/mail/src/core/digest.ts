// Today (slice 3f), the pure part: which conversations need a reply, when
// the day's digest is due, the counts since the previous digest and the
// server-local day. The store supplies candidates; nothing here calls a
// model or writes anything.
import type { Category } from "./categories.ts";
import { isBulkRow } from "./contacts.ts";
import type { SpecialUse } from "./model.ts";

/** A conversation's latest message, as the store answers `replyCandidates`. */
export type ReplyCandidate = {
  threadId: string;
  accountId: string;
  messageId: string;
  dedupKey: string;
  /** ISO 8601. */
  date: string;
  folderRole: SpecialUse | null;
  fromAddress: string;
  to: string[];
  cc: string[];
  bulk: boolean | null;
  /** The newest Sent-role message of the conversation, ISO 8601, or null. */
  lastSentAt: string | null;
};

export const NEEDS_REPLY_MAX_AGE_DAYS = 14;
export const NEEDS_REPLY_MAX = 30;

/** The reply_dismissals key of a latest message. */
export const dismissalKey = (accountId: string, dedupKey: string) => `${accountId}\u0000${dedupKey}`;

const lower = (address: string) => address.trim().toLowerCase();

/**
 * Conversations whose latest message waits for the owner's reply: in an
 * Inbox-role folder, at most 14 days old, not from the owner, not bulk or
 * automated, from someone the owner has written to or with one of the
 * owner's addresses in To (Cc alone is not enough), not snoozed, no Sent
 * message after it, not dismissed (by the latest message's dedup key, so a
 * newer message brings it back). At most 30, newest first.
 */
export function needsReply(
  candidates: readonly ReplyCandidate[],
  ctx: {
    own: ReadonlySet<string>;
    sentTo: ReadonlySet<string>;
    /** dismissalKey(accountId, dedupKey) values. */
    dismissed: ReadonlySet<string>;
    /** Snoozed thread ids. */
    snoozed: ReadonlySet<string>;
    now: Date;
  },
): ReplyCandidate[] {
  const oldest = ctx.now.getTime() - NEEDS_REPLY_MAX_AGE_DAYS * 86_400_000;
  const out = candidates.filter((c) => {
    if (c.folderRole !== "inbox") return false;
    const at = Date.parse(c.date);
    if (!Number.isFinite(at) || at < oldest) return false;
    const from = lower(c.fromAddress);
    if (ctx.own.has(from)) return false;
    if (isBulkRow(c.bulk, from)) return false;
    if (!ctx.sentTo.has(from) && !c.to.some((address) => ctx.own.has(lower(address)))) return false;
    if (ctx.snoozed.has(c.threadId)) return false;
    if (c.lastSentAt !== null && Date.parse(c.lastSentAt) > at) return false;
    return !ctx.dismissed.has(dismissalKey(c.accountId, c.dedupKey));
  });
  out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return out.slice(0, NEEDS_REPLY_MAX);
}

const DIGEST_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after local midnight of a "HH:MM" setting, or null when malformed. */
export function parseDigestTime(text: string): number | null {
  const match = DIGEST_TIME.exec(text.trim());
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** Whether a tick builds today's digest: not built yet and at or after the time (a late start builds it at once). */
export function digestDue(state: { day: string; localMinutes: number; built: boolean }, digestMinutes: number): boolean {
  return !state.built && state.localMinutes >= digestMinutes;
}

export type SinceCounts = { notifications: number; newsletters: number; bills: number; bulk: number; personal: number };

/**
 * New Inbox rows since the previous digest: by label or suggestion with
 * categories on, else bulk against personal.
 */
export function sinceCounts(
  rows: readonly { bulk: boolean | null; fromAddress: string; category: Category | null }[],
  categoriesOn: boolean,
): SinceCounts {
  const counts: SinceCounts = { notifications: 0, newsletters: 0, bills: 0, bulk: 0, personal: 0 };
  for (const row of rows) {
    if (categoriesOn) {
      if (row.category !== null) counts[row.category] += 1;
    } else if (isBulkRow(row.bulk, row.fromAddress)) {
      counts.bulk += 1;
    } else {
      counts.personal += 1;
    }
  }
  return counts;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The server-local day "YYYY-MM-DD". */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Minutes after local midnight. */
export function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
