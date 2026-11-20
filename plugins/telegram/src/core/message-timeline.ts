import type { Message } from "./demo.ts";
import { groupMessageAlbums } from "./message-albums.ts";
import { clearChatDateRange, messageSearchDateRange } from "./contract.ts";

export function searchDays(from: string, through: string) {
  if (!from && !through) return;
  const end = through ? new Date(`${through}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
  return messageSearchDateRange.safeParse({
    ...(from && { from: new Date(`${from}T00:00:00`).getTime() / 1000 }),
    ...(end && { until: end.getTime() / 1000 }),
  });
}

export function localDayEnd(day: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  const boundary = new Date(`${day}T00:00:00`);
  boundary.setDate(boundary.getDate() + 1);
  const end = Math.min(2147483647, Math.floor(boundary.getTime() / 1000) - 1);
  return Number.isInteger(end) && end > 0 ? end : undefined;
}

export function localDateInputValue(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function clearHistoryDays(from: string, through: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through)) return;
  const start = new Date(`${from}T00:00:00`).getTime() / 1000;
  const lastDay = new Date(`${through}T00:00:00`).getTime() / 1000;
  if (localDateInputValue(start) !== from || localDateInputValue(lastDay) !== through) return;
  return clearChatDateRange.safeParse({ start, end: localDayEnd(through) }).data;
}

export function groupMessageTimeline(messages: readonly Message[]) {
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let previousDay: string | undefined;
  const seenAlbums = new Set<string>();
  return groupMessageAlbums(messages).map((group) => {
    const first = group[0]!;
    const id = first.albumId;
    const albumKey = id ? seenAlbums.has(id) ? `album:${id}:${first.id}` : `album:${id}` : undefined;
    if (id) seenAlbums.add(id);
    const timestamp = first.timestamp;
    if (!timestamp) return { group, albumKey };
    const day = format.format(timestamp * 1000);
    if (day === previousDay) return { group, albumKey };
    previousDay = day;
    return { group, day, albumKey };
  });
}


export function firstLoadedUnread(messages: readonly Message[], loaded: readonly Message[], inbox: number, complete: boolean) {
  if (!complete && !loaded.some((message) => !message.retained && Number(message.id) <= inbox)) return;
  return messages.find((message) => !message.outgoing && !message.service && !message.retained && !message.pendingDelivery
    && Number.isSafeInteger(Number(message.id)) && Number(message.id) > inbox)?.id;
}
