// Auto drafts (AI writes mail), the pure rules: which new Inbox messages
// get a reply drafted, the daily cap, and when a kept draft is no longer
// wanted. The model call itself goes through the AI job runner.
import { isBulkRow } from "./contacts.ts";
import type { SpecialUse } from "./model.ts";

export const AUTO_DRAFTS_PER_DAY = 50;
/** Most messages waiting for a draft; past it the oldest waiting one is dropped. */
export const AUTO_DRAFT_QUEUE = 20;
/** How long the queue waits when the job runner is busy. */
export const AUTO_DRAFT_RETRY_MS = 30_000;
/** Most kept drafts. */
export const REPLY_DRAFTS_MAX = 200;
export const REPLY_DRAFT_DAYS = 14;
/** Characters of a draft shown next to the message. */
export const REPLY_DRAFT_PREVIEW = 240;

/** A reply drafted for a message, kept until the owner uses or dismisses it. */
export type ReplyDraftRecord = {
  messageId: string;
  accountId: string;
  paragraphs: string[];
  linksRemoved: number;
  provider: string;
  model: string;
  /** ISO 8601. */
  createdAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const lower = (text: string) => text.trim().toLowerCase();

/** A new message as the rule reads it. */
export type AutoDraftRow = {
  folderRole: SpecialUse | null;
  /** The stored bulk signal; null: unknown (the address decides). */
  bulk: boolean | null;
  /** It carries a mailing list's key. */
  listed: boolean;
  fromAddress: string;
  /** To addresses (not Cc). */
  to: readonly string[];
  hasBody: boolean;
  inAiScope: boolean;
  /** The sender check failed, or Mail warns about the sender (a Reply-To elsewhere, a lookalike domain, a disguised name). */
  suspicious: boolean;
  /** Reply-To addresses; a reply goes there, not to From. */
  replyTo: readonly string[];
  /** The owner has already written in the conversation after this message. */
  answered: boolean;
};

/**
 * Whether a reply is drafted: in the Inbox, inside AI access, with a body,
 * not bulk, a list or automated, not the owner's own, from someone the owner
 * has written to, and addressed (To) to the owner. A message Mail warns
 * about, one whose reply would go to an address the owner never wrote to,
 * and one the owner has answered are left alone.
 */
export function eligible(row: AutoDraftRow, ctx: { own: ReadonlySet<string>; sentTo: ReadonlySet<string> }): boolean {
  if (row.folderRole !== "inbox" || !row.inAiScope || !row.hasBody) return false;
  if (row.listed || isBulkRow(row.bulk, row.fromAddress)) return false;
  const from = lower(row.fromAddress);
  if (ctx.own.has(from) || !ctx.sentTo.has(from)) return false;
  if (row.suspicious || row.answered) return false;
  if (row.replyTo.some((address) => !ctx.sentTo.has(lower(address)))) return false;
  return row.to.some((address) => ctx.own.has(lower(address)));
}

/** The daily cap: at most AUTO_DRAFTS_PER_DAY in any 24 hours. */
export class DraftBudget {
  private readonly taken: number[] = [];
  constructor(private readonly clock: { now(): Date }) {}

  /** Whether one more may start today. */
  left(): boolean {
    const now = this.clock.now().getTime();
    while (this.taken.length > 0 && this.taken[0]! <= now - DAY_MS) this.taken.shift();
    return this.taken.length < AUTO_DRAFTS_PER_DAY;
  }

  /** Takes one; false when the day's drafts are used up. */
  take(): boolean {
    if (!this.left()) return false;
    this.taken.push(this.clock.now().getTime());
    return true;
  }
}

/**
 * Whether a kept draft is no longer wanted: its message is gone (null), in
 * Trash or Spam or no longer inside AI access, the owner answered in the conversation after the draft
 * was made, or it is REPLY_DRAFT_DAYS old.
 */
export function replyDraftStale(
  draft: { createdAt: string },
  message: { folderRole: SpecialUse | null; ownerRepliedAt: string | null; inAiScope: boolean } | null,
  now: Date,
): boolean {
  if (message === null || message.folderRole === "trash" || message.folderRole === "junk" || !message.inAiScope) return true;
  const made = Date.parse(draft.createdAt);
  if (message.ownerRepliedAt !== null && Date.parse(message.ownerRepliedAt) > made) return true;
  return now.getTime() - made >= REPLY_DRAFT_DAYS * DAY_MS;
}
