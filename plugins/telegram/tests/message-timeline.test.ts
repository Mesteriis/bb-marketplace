import { expect, test } from "vitest";
import type { Message } from "../src/core/demo.ts";
import { groupMessageTimeline } from "../src/core/message-timeline.ts";

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
