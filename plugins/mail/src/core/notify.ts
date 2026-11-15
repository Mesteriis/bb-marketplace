// New-mail notifications (slice 3e): which freshly synced Inbox rows toast,
// quiet hours, and the sender name a toast shows. Pure; the server keeps the
// kept ids in memory and publishes a token only (no mail content).
import { revealHidden } from "./agent-propose.ts";
import { matchesBlock, type BlockRule } from "./blocking.ts";
import { isBulkRow } from "./contacts.ts";
import type { SpecialUse } from "./model.ts";

/** Mail older than this (by its date, else its fetch time) never toasts. */
export const NOTIFY_MAX_AGE_MS = 6 * 3_600_000;
/** Senders a toast names at most; the rest are counted. */
export const NEW_MAIL_TOAST_ITEMS = 3;

const TOAST_NAME_MAX = 60;

/** A stored row as `notifiable` judges it (store `notifyRows`). */
export type NotifyRow = {
  id: string;
  accountId: string;
  threadId: string;
  folderRole: SpecialUse | null;
  isRead: boolean;
  movePending: string | null;
  uid: number | null;
  bulk: boolean | null;
  fromName: string | null;
  fromAddress: string;
  date: string | null;
  fetchedAt: string;
};

export type NotifyContext = {
  /** The owner's addresses, lower case. */
  own: ReadonlySet<string>;
  /** Addresses the owner has written to, lower case. */
  sentTo: ReadonlySet<string>;
  rules: readonly BlockRule[];
  now: Date;
  /** The time a row's age is measured from; a snooze return passes its return time (spec resolution 16). */
  ageFrom?: (row: NotifyRow) => string;
};

function timeOf(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

/**
 * The rows that toast (spec "Which messages"): unread, attached, not moving,
 * in the Inbox; not bulk; not from the owner; from someone the owner wrote
 * to; not blocked; at most six hours old.
 */
export function notifiable(rows: readonly NotifyRow[], ctx: NotifyContext): NotifyRow[] {
  const now = ctx.now.getTime();
  return rows.filter((row) => {
    if (row.isRead || row.uid === null || row.movePending !== null || row.folderRole !== "inbox") return false;
    if (isBulkRow(row.bulk, row.fromAddress)) return false;
    const from = row.fromAddress.trim().toLowerCase();
    if (ctx.own.has(from) || !ctx.sentTo.has(from)) return false;
    if (matchesBlock(from, ctx.rules) !== null) return false;
    const since =
      (ctx.ageFrom !== undefined ? timeOf(ctx.ageFrom(row)) : null) ?? timeOf(row.date) ?? timeOf(row.fetchedAt);
    return since !== null && now - since <= NOTIFY_MAX_AGE_MS;
  });
}

/** Minutes after local midnight; `start` may be after `end` (crosses midnight). */
export type QuietHours = { start: number; end: number };

const QUIET = /^([01]\d|2[0-3]):([0-5]\d)[-\u2013]([01]\d|2[0-3]):([0-5]\d)$/;

/** The setting's range, or null when empty, malformed or with equal ends (off). */
export function parseQuietHours(text: string): QuietHours | null {
  const match = QUIET.exec(text.trim());
  if (match === null) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start === end ? null : { start, end };
}

/** Whether `localMinutes` (minutes after local midnight) falls inside the range; the end is outside. */
export function inQuietHours(range: QuietHours | null, localMinutes: number): boolean {
  if (range === null) return false;
  return range.start < range.end
    ? localMinutes >= range.start && localMinutes < range.end
    : localMinutes >= range.start || localMinutes < range.end;
}

/** The sender as a toast names it: hidden characters removed, one line, 60 characters; the address when empty. */
export function toastName(name: string | null, address: string): string {
  const shown = revealHidden(name ?? "")
    .shown.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shown === "" ? address : [...shown].slice(0, TOAST_NAME_MAX).join("");
}
