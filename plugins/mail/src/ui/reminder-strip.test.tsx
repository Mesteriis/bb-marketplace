// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReminderView } from "../core/model.ts";
import { RemindDialog, ReminderStrip, reminderDays } from "./reminder-strip.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const REMINDER: ReminderView = {
  id: "rem-1",
  accountId: "acc-1",
  threadId: "th-1",
  state: "due",
  days: 3,
  sentAt: "2026-11-10T09:00:00.000Z",
  dueAt: "2026-11-13T09:00:00.000Z",
  recipient: { name: "Ada Example", address: "ada@example.org" },
  subject: "Contract draft",
};

describe("ReminderStrip", () => {
  it("lists due reminders with Open, Remind in N days and Dismiss", () => {
    const props = { onOpen: vi.fn(), onSnooze: vi.fn(), onDismiss: vi.fn() };
    render(<ReminderStrip reminders={[REMINDER]} defaultDays={2} {...props} />);
    expect(screen.getByRole("region", { name: "Waiting for a reply" })).toBeTruthy();
    expect(screen.getByText("Ada Example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(props.onOpen).toHaveBeenCalledWith(REMINDER);
    fireEvent.click(screen.getByRole("button", { name: "Remind in 2 days" }));
    expect(props.onSnooze).toHaveBeenCalledWith(REMINDER, 2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismiss).toHaveBeenCalledWith(REMINDER);
  });

  it("shows nothing without reminders; Open is off when the conversation is gone", () => {
    const { container, rerender } = render(
      <ReminderStrip reminders={[]} defaultDays={3} onOpen={vi.fn()} onSnooze={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    rerender(
      <ReminderStrip reminders={[{ ...REMINDER, threadId: null }]} defaultDays={1} onOpen={vi.fn()} onSnooze={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect((screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Remind in 1 day" })).toBeTruthy();
  });

  it("Remind me takes 1 to 30 days", () => {
    expect([reminderDays("1"), reminderDays("30"), reminderDays("0"), reminderDays("31"), reminderDays("2.5")]).toEqual([
      1,
      30,
      null,
      null,
      null,
    ]);
    const onRemind = vi.fn();
    render(<RemindDialog open defaultDays={3} onRemind={onRemind} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "40" } });
    expect((screen.getByRole("button", { name: "Remind me" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Remind me" }));
    expect(onRemind).toHaveBeenCalledWith(5);
  });
});
