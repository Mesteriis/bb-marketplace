// Reply reminders (slice 3f), the pure part: the limits, when a stored row
// answers a sent message, and when a reminder turns due. Answered by
// In-Reply-To or References only, from any sender, never by the sent
// message itself, a bulk row or an automated sender (spec resolution 7).
import { isAutomatedAddress, isBulkRow } from "./contacts.ts";
import { toastName } from "./notify.ts";

export const REMINDER_DAYS = { min: 1, max: 30 } as const;
export const REMINDERS_LIVE_MAX = 500;
export const ANSWERED_KEEP_DAYS = 30;

export const REMINDER_STATES = ["queued", "waiting", "due", "answered", "dismissed"] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

/** A Message-ID without angle brackets or surrounding space. */
function bareId(id: string): string {
  const text = id.trim();
  return text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1).trim() : text;
}

/**
 * Whether `row` answers the reminder's sent message: dated after `sentAt`,
 * not the sent message itself, not bulk or automated, and its In-Reply-To
 * or References holds the sent Message-ID.
 */
export function answers(
  reminder: { rfcMessageId: string; sentAt: string },
  row: {
    messageId: string | null;
    inReplyTo: string | null;
    references: readonly string[];
    date: string | null;
    bulk: boolean | null;
    fromAddress: string;
  },
): boolean {
  const sent = bareId(reminder.rfcMessageId);
  if (sent === "") return false;
  if (row.messageId !== null && bareId(row.messageId) === sent) return false;
  if (isBulkRow(row.bulk, row.fromAddress) || isAutomatedAddress(row.fromAddress)) return false;
  const at = row.date === null ? NaN : Date.parse(row.date);
  const sentAt = Date.parse(reminder.sentAt);
  if (!Number.isFinite(at) || !Number.isFinite(sentAt) || at <= sentAt) return false;
  if (row.inReplyTo !== null && bareId(row.inReplyTo) === sent) return true;
  return row.references.some((ref) => bareId(ref) === sent);
}

/** When a reminder turns due: `days` calendar days after `sentAt`, the local time of day kept across a DST change. */
export function dueAt(sentAt: string, days: number): string {
  const date = new Date(sentAt);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** The recipient as a reminder toast names them (hidden characters removed, one line, 60 characters). */
export function reminderToastName(name: string | null, address: string): string {
  return toastName(name, address);
}
