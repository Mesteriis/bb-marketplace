// The new-mail toast (slice 3e): what it says for the senders behind one
// mail-new token. The sender's name and address only, never a subject or
// any text (spec resolution 1); the address is always there, so a display
// name alone cannot pass as someone else. Host-free: app.tsx shows it.
import type { NewMailItem } from "../core/model.ts";

/** How long a new-mail toast stays. */
export const NEW_MAIL_TOAST_MS = 8_000;

export interface NewMailToastPlan {
  title: string;
  description: string;
  /** The conversation Open goes to: the newest message's. */
  open: { accountId: string; threadId: string };
}

/**
 * The toast for `items` (newest first) and `more` further messages; null
 * when there is nothing, or when the Mail page already shows an Inbox
 * (its list updates by itself).
 */
export function newMailToastPlan(
  items: readonly NewMailItem[],
  more: number,
  pageShowsInbox: boolean,
): NewMailToastPlan | null {
  const newest = items[0];
  if (newest === undefined || pageShowsInbox) return null;
  const total = items.length + Math.max(0, more);
  const open = { accountId: newest.accountId, threadId: newest.threadId };
  if (total === 1) return { title: `New mail from ${newest.name}`, description: newest.address, open };
  return {
    title: `New mail from ${newest.name} and ${total - 1} more`,
    description: `${total} messages`,
    open,
  };
}
