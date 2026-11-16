import type { HistoryPage } from "./contract.ts";

export async function fillHistoryGap(
  latest: HistoryPage,
  newestLoaded: number,
  loadOlder: (before: string) => Promise<HistoryPage>,
  isCurrent: () => boolean,
): Promise<HistoryPage | undefined> {
  if (!isCurrent()) return;
  const incoming = new Map(latest.messages.map((message) => [message.id, message]));
  let cursor = latest.before;
  while (cursor && Number(cursor) > newestLoaded) {
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
  return { ...latest, messages: [...incoming.values()] };
}

export function mergeLatestHistory(previous: HistoryPage | undefined, latest: HistoryPage): HistoryPage {
  if (!previous) return latest;
  const merged = new Map(previous.messages.map((message) => [message.id, message]));
  for (const message of latest.messages) merged.set(message.id, message);
  return {
    ...(latest.draft === undefined ? {} : { draft: latest.draft }),
    readOutbox: latest.readOutbox === undefined ? previous.readOutbox : Math.max(latest.readOutbox, previous.readOutbox ?? 0),
    messages: [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    before: previous.messages.length ? previous.before : latest.before,
  };
}
