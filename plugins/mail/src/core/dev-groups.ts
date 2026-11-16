// The Dev view's groups (slice 3g, #37): dev notifications by repository
// (or monitoring service), one row per stored copy key. Pure; both stores
// group their rows here.
import type { DevKind, DevSource, DevState } from "./dev-notify.ts";
import type { DevGroupRow } from "./ports.ts";

/** Message ids kept per dev group (Mark read and Archive act on them). */
export const DEV_GROUP_IDS_MAX = 200;

/** One classified message as the stores list it, newest first. */
export type DevListRow = {
  id: string;
  accountId: string;
  dedupKey: string;
  source: DevSource;
  repo: string | null;
  kind: DevKind;
  state: DevState | null;
  subject: string;
  date: string | null;
  isRead: boolean;
};

/**
 * Rows (newest first) as groups by (source, repo), one row per (account,
 * dedup key); groups ordered by their latest message.
 */
export function groupDevRows(rows: readonly DevListRow[]): DevGroupRow[] {
  const groups = new Map<string, DevGroupRow>();
  const seen = new Set<string>();
  for (const row of rows) {
    const copy = `${row.accountId}\u0000${row.dedupKey}`;
    if (seen.has(copy)) continue;
    seen.add(copy);
    const key = `${row.source}\u0000${row.repo ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        source: row.source,
        repo: row.repo,
        counts: {},
        ciFailed: 0,
        latestFailure: null,
        unread: 0,
        total: 0,
        latestDate: row.date,
        messageIds: [],
      };
      groups.set(key, group);
    }
    group.total++;
    group.counts[row.kind] = (group.counts[row.kind] ?? 0) + 1;
    if (!row.isRead) group.unread++;
    if (row.kind === "ci" && row.state === "failed") {
      group.ciFailed++;
      if (group.latestFailure === null) group.latestFailure = { messageId: row.id, subject: row.subject, date: row.date };
    }
    if (group.messageIds.length < DEV_GROUP_IDS_MAX) group.messageIds.push(row.id);
  }
  return [...groups.values()];
}

/** A page of groups; the cursor is the offset of the next group. */
export function pageDevGroups(
  groups: readonly DevGroupRow[],
  cursor: string | null,
  limit: number,
): { groups: DevGroupRow[]; next: string | null } {
  const offset = cursor === null ? 0 : Math.max(0, Number(cursor) || 0);
  const page = groups.slice(offset, offset + limit);
  return { groups: page, next: offset + limit < groups.length ? String(offset + limit) : null };
}
