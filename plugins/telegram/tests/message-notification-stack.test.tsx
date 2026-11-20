// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MessageNotificationStack } from "../src/ui/message-notification-banner.tsx";
import type { MessageNotification } from "../src/core/contract.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const chat = { id: "42", name: "Fixture team", initials: "FT", color: "#7466aa", subtitle: "Group", messages: [] };
const first = { key: "fixture:1", chatId: "42", messageId: "111", topicId: 7, preview: "First synthetic message" };
const second = { key: "fixture:2", chatId: "42", messageId: "112", preview: "Second synthetic message" };

test("keeps unread notifications, unfolds downward on demand and opens the exact selected message", () => {
  vi.useFakeTimers();
  const open = vi.fn();
  const props = (notices: MessageNotification[]) => <MessageNotificationStack notices={notices} chats={[chat]} open={open} />;
  const view = render(props([second, first]));
  const stack = within(screen.getByRole("complementary", { name: "Telegram notification" }));
  expect(stack.queryByText(first.preview)).toBeNull();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(stack.getByText(second.preview)).toBeTruthy();
  fireEvent.click(stack.getByRole("button", { name: "More notifications (1)" }));
  expect(stack.getByRole("button", { name: "Collapse notifications" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(stack.getAllByRole("button", { name: "Open message" })[1]!);
  expect(open).toHaveBeenCalledExactlyOnceWith(first, chat);
  expect(stack.getByText(first.preview)).toBeTruthy();
  view.rerender(props([second]));
  expect(view.container.querySelector("[data-leaving]")?.textContent).toContain(first.preview);
  act(() => { vi.advanceTimersByTime(220); });
  expect(stack.queryByText(first.preview)).toBeNull();
  expect(stack.getByText(second.preview)).toBeTruthy();
});

test("hides a card explicitly without marking its message read", () => {
  const open = vi.fn();
  const markRead = vi.fn();
  render(<MessageNotificationStack notices={[first]} chats={[chat]} open={open} markRead={markRead} />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByRole("complementary", { name: "Telegram notification" })).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});
