import { expect, test } from "vitest";
import type { Message } from "../src/core/demo.ts";
import { groupMessageTimeline } from "../src/core/message-timeline.ts";
import { prependHistory } from "../src/core/history-refresh.ts";

test("prepends each earlier message once and keeps the latest unread boundary", () => {
  const message = (id: string, text = id): Message => ({ id, text, time: "", author: "Fixture" });
  const older = { messages: [message("18"), message("18"), message("19"), message("20", "stale")], before: "18", readInbox: 10 };
  const latest = { messages: [message("20"), message("21")], before: "20", readInbox: 19, unreadCount: 2 };
  expect(prependHistory(latest, older)).toEqual({
    messages: ["18", "19", "20", "21"].map((id) => message(id)), before: "18", readInbox: 19, unreadCount: 2,
  });
});

test("merges overlapping earlier history in order and stops a cursor that did not move backward", () => {
  const item = (id: string): Message => ({ id, text: id, time: "", author: "Fixture" });
  const previous = { messages: [item("20"), item("24")], before: "20" };
  const older = { messages: [item("17"), item("20"), item("23")], before: "20" };
  const merged = prependHistory(previous, older);
  expect(merged.messages.map(({ id }) => id)).toEqual(["17", "20", "23", "24"]);
  expect(merged.before).toBeNull();
  expect(prependHistory(previous, { messages: [], before: "22" }).before).toBeNull();
});

test("adds one divider per local day without splitting albums or repeating a prepended date", () => {
  const firstDay = new Date(2026, 10, 14, 23, 59);
  const secondDay = new Date(2026, 10, 15, 0, 1);
  const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const message = (id: string, date?: Date, albumId?: string): Message => ({
    id, text: "Fixture", author: "", time: "",
    timestamp: date ? date.getTime() / 1000 : undefined, albumId,
  });
  const messages = [
    message("1", firstDay),
    message("2", firstDay),
    message("3"),
    message("4", firstDay, "99"),
    message("5", secondDay, "99"),
    message("6", secondDay),
    message("7", secondDay),
  ];
  const row = ({ day, group }: ReturnType<typeof groupMessageTimeline>[number]) => [day, group.map(({ id }) => id)];
  expect(groupMessageTimeline(messages).map(row)).toEqual([
    [dateLabel.format(firstDay), ["1"]],
    [undefined, ["2"]],
    [undefined, ["3"]],
    [undefined, ["4", "5"]],
    [dateLabel.format(secondDay), ["6"]],
    [undefined, ["7"]],
  ]);
  expect(groupMessageTimeline(messages.slice(1)).map(row)[0]).toEqual([dateLabel.format(firstDay), ["2"]]);
});
