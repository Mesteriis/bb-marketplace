// Subscriptions (slice 3n, #87): the mailing lists the stored mail comes
// from, with how much each sends, for unsubscribing from several at once.
// Pure: groups scanned rows into lists. A list is what "Archive all from
// this list" calls one (sameList): a List-Id, or for mail without one the
// sender's address. Everything here comes from the senders and is untrusted;
// the list's own key never leaves the server.
import { LIST_KEY_ID, offeredMethods, type UnsubscribeInfo } from "./unsubscribe.ts";

/** How many stored messages one overview reads, newest first. */
export const SUBSCRIPTIONS_SCAN_MAX = 50_000;
/** How many lists one overview shows, largest first. */
export const SUBSCRIPTIONS_MAX = 200;
/** How many lists one click unsubscribes from: the per-minute send cap. */
export const SUBSCRIPTIONS_BATCH_MAX = 10;

/** One stored message that carries unsubscribe headers. */
export type SubscriptionRow = {
  id: string;
  accountId: string;
  dedupKey: string;
  fromName: string | null;
  fromAddress: string;
  /** ISO 8601, or null. */
  date: string | null;
  isRead: boolean;
  info: UnsubscribeInfo;
};

export type SubscriptionMethod = "one_click" | "mailto";

export type Subscription = {
  /** The newest stored message of the list: what unsubscribe_run is asked with. */
  messageId: string;
  accountId: string;
  /** The server's own; removed before the page sees the list. */
  listKey: string;
  /** The list's name, else the sender's name, else the address. */
  name: string;
  address: string;
  total: number;
  unread: number;
  lastDate: string | null;
  /** What Mail would use: one-click when the message is covered, else the mailto; null: neither. */
  method: SubscriptionMethod | null;
  /** Where the request goes: the one-click host, or the mailto address. */
  target: string | null;
  /**
   * False when the request would go by email to a domain that is not the
   * sender's: that one is decided in the message, where the address is shown.
   */
  batch: boolean;
  /** For the mailto: the exact subject and text the email carries, as the unsubscribe dialog shows them. */
  mail: { subject: string; body: string; hiddenChars: number } | null;
};

/** The lists of `rows` (newest first), largest first; at most `max`. */
export function groupSubscriptions(rows: readonly SubscriptionRow[], max = SUBSCRIPTIONS_MAX): Subscription[] {
  const groups = new Map<string, { first: SubscriptionRow; seen: Set<string>; unread: Set<string> }>();
  for (const row of rows) {
    const from = row.fromAddress.trim().toLowerCase();
    // A From-fallback key covers only mail from that address (sameList).
    const key = `${row.accountId}\u0000${row.info.listKey}${row.info.listKey.startsWith(LIST_KEY_ID) ? "" : `\u0000${from}`}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { first: row, seen: new Set(), unread: new Set() };
      groups.set(key, group);
    }
    group.seen.add(row.dedupKey);
    if (!row.isRead) group.unread.add(row.dedupKey);
  }
  return [...groups.values()]
    .map(({ first, seen, unread }): Subscription => {
      const offered = offeredMethods(first.info, first.fromAddress);
      const method: SubscriptionMethod | null = offered.oneClick !== null ? "one_click" : offered.mailto !== null ? "mailto" : null;
      return {
        messageId: first.id,
        accountId: first.accountId,
        listKey: first.info.listKey,
        name: first.info.listName?.trim() || first.fromName?.trim() || first.fromAddress,
        address: first.fromAddress,
        total: seen.size,
        unread: unread.size,
        lastDate: first.date,
        method,
        target: offered.oneClick !== null ? offered.oneClick.host : (offered.mailto?.address ?? null),
        batch: method === "one_click" || (method === "mailto" && offered.mailto !== null && !offered.mailto.foreignDomain),
        mail:
          method === "mailto" && offered.mailto !== null
            ? { subject: offered.mailto.subject, body: offered.mailto.body, hiddenChars: offered.mailto.hiddenChars }
            : null,
      };
    })
    .sort((a, b) => b.total - a.total || (b.lastDate ?? "").localeCompare(a.lastDate ?? "") || a.messageId.localeCompare(b.messageId))
    .slice(0, max);
}
