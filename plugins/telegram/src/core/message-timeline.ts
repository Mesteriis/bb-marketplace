import type { Message } from "./demo.ts";
import { groupMessageAlbums } from "./message-albums.ts";

export function localDateInputValue(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function groupMessageTimeline(messages: readonly Message[]) {
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let previousDay: string | undefined;
  return groupMessageAlbums(messages).map((group) => {
    const timestamp = group[0]?.timestamp;
    if (!timestamp) return { group };
    const day = format.format(timestamp * 1000);
    if (day === previousDay) return { group };
    previousDay = day;
    return { group, day };
  });
}
