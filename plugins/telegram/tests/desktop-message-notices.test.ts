// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { showDesktopMessageNotice, telegramWindowInBackground } from "../src/adapters/bb/desktop-message-notices.ts";

test("routes a hidden or unfocused BB window to desktop notifications", () => {
  expect(telegramWindowInBackground({ visibilityState: "visible", hasFocus: () => true })).toBe(false);
  expect(telegramWindowInBackground({ visibilityState: "visible", hasFocus: () => false })).toBe(true);
  expect(telegramWindowInBackground({ visibilityState: "hidden", hasFocus: () => true })).toBe(true);
});

test("system notifications respect permission, preserve preview privacy and open the exact alert", () => {
  class DesktopHost {
    static permission: NotificationPermission = "denied";
    static create = vi.fn();
    close = vi.fn();
    onclick?: () => void;
    constructor(title: string, options: NotificationOptions) {
      DesktopHost.create(title, options);
    }
  }
  const host = DesktopHost as unknown as typeof Notification;
  const notice = { key: "1:5", chatId: "22", messageId: "88", topicId: 17 };
  const options = { title: "Fixture chat", fallback: "New message", scope: "fixture", open: vi.fn() };
  expect(showDesktopMessageNotice(notice, options, host)).toBeUndefined();
  DesktopHost.permission = "granted";
  expect(showDesktopMessageNotice({ ...notice, pendingMessage: true }, options, host)).toBeUndefined();
  const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
  try {
    const banner = showDesktopMessageNotice(notice, options, host) as unknown as DesktopHost;
    expect(DesktopHost.create).toHaveBeenCalledExactlyOnceWith("Fixture chat", { body: "New message", tag: "bb-telegram:fixture:1:5" });
    banner.onclick?.();
    expect(options.open).toHaveBeenCalledExactlyOnceWith(notice);
    expect(banner.close).toHaveBeenCalledOnce();
  } finally {
    focus.mockRestore();
  }
});
