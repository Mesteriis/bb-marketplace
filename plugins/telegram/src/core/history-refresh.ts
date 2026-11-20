import type { HistoryPage } from "./contract.ts";

export function earlierHistoryCursor(previous: string | null | undefined, next: string | null): string | null {
  if (!next || !/^[1-9]\d{0,15}$/.test(next) || !Number.isSafeInteger(Number(next))) return null;
  if (previous && !(Number(next) < Number(previous))) return null;
  return next;
}

export function prependHistory(previous: HistoryPage, older: HistoryPage): HistoryPage {
  const seen = new Set(previous.messages.map(({ id }) => id));
  const messages = older.messages.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const combined = [...messages, ...previous.messages];
  if (messages.length && previous.messages.length && Number(messages.at(-1)?.id) > Number(previous.messages[0]?.id)) {
    combined.sort((a, b) => Number(a.id) - Number(b.id));
  }
  return { ...previous, messages: combined, before: earlierHistoryCursor(previous.before, older.before),
    ...(older.predecessor && { predecessor: older.predecessor }) };
}

export async function fillHistoryGap(
  latest: HistoryPage,
  newestLoaded: number,
  loadOlder: (before: string) => Promise<HistoryPage>,
  isCurrent: () => boolean,
): Promise<{ page: HistoryPage; disconnected: boolean } | undefined> {
  if (!isCurrent()) return;
  const incoming = new Map(latest.messages.map((message) => [message.id, message]));
  let cursor = latest.before;
  // Short gaps can be stitched immediately. Longer ones keep their normal pagination cursor.
  for (let count = 0; count < 2 && cursor && Number(cursor) > newestLoaded; count++) {
    const older = await loadOlder(cursor);
    if (!isCurrent()) return;
    if (older.before && !(Number(older.before) < Number(cursor))) {
      throw new Error("Telegram history cursor did not advance.");
    }
    for (const message of older.messages) {
      if (Number(message.id) >= newestLoaded && !incoming.has(message.id)) incoming.set(message.id, message);
    }
    cursor = older.before;
  }
  const disconnected = !!cursor && Number(cursor) > newestLoaded;
  const messages = [...incoming.values()].sort((a, b) => Number(a.id) - Number(b.id));
  return { page: { ...latest, messages, before: disconnected ? cursor : latest.before }, disconnected };
}

export function mergeLatestHistory(previous: HistoryPage | undefined, latest: HistoryPage): HistoryPage {
  if (!previous) return latest;
  const merged = new Map(previous.messages.map((message) => [message.id, message]));
  const oldest = Number(previous.messages[0]?.id ?? 0);
  const predecessor = latest.predecessor ?? previous.predecessor;
  const migration = latest.migration ?? previous.migration;
  // A larger latest page can overlap the range reserved for scrolling back.
  for (const message of latest.messages) {
    if (Number(message.id) >= oldest) merged.set(message.id, message);
  }
  return {
    ...(latest.draft === undefined ? {} : { draft: latest.draft }),
    unreadCount: latest.unreadCount ?? previous.unreadCount,
    readInbox: latest.readInbox === undefined ? previous.readInbox : Math.max(latest.readInbox, previous.readInbox ?? 0),
    readOutbox: latest.readOutbox === undefined ? previous.readOutbox : Math.max(latest.readOutbox, previous.readOutbox ?? 0),
    messages: [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    before: previous.messages.length ? previous.before : latest.before,
    ...(predecessor && { predecessor }),
    ...(migration && { migration }),
  };
}

export function appendUnreadHistory(previous: HistoryPage, next: HistoryPage): HistoryPage {
  return { ...mergeLatestHistory(previous, next), openAt: previous.openAt,
    after: next.after && Number(next.after) > Number(previous.after) ? next.after : undefined };
}


export function replaceLoadedHistoryMessage<T extends { messages: HistoryPage["messages"] }>(page: T, row: HistoryPage["messages"][number]): T {
  const index = page.messages.findIndex((previous) => previous.id === row.id
    && !previous.retained && (row.retained || row.restricted || (previous.editedAt ?? 0) <= (row.editedAt ?? 0)));
  if (index < 0) return page;
  const messages = page.messages.slice();
  messages[index] = row;
  return { ...page, messages };
}
