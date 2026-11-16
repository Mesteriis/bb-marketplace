// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayView as TodayData } from "../core/contract.ts";
import type { ThreadSummary } from "../core/model.ts";
import { TodayView } from "./today-view.tsx";
import { BASE, HOSTILE, fakePorts } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const THREAD: ThreadSummary = {
  id: "th-1",
  accountId: "acc-1",
  subject: "Contract draft",
  lastDate: "2026-11-15T09:00:00.000Z",
  messageCount: 2,
  unreadCount: 1,
  participants: [{ name: "Ada Example", address: "ada@example.org" }],
  snippet: "Could you check",
  flagged: false,
  snoozedUntil: null,
  category: null,
  categorySuggestion: null,
  projectId: null,
};

const DATA: TodayData = {
  needsReply: [THREAD],
  waiting: [
    {
      id: "rem-1",
      accountId: "acc-1",
      threadId: "th-2",
      state: "due",
      days: 3,
      sentAt: "2026-11-10T09:00:00.000Z",
      dueAt: "2026-11-13T09:00:00.000Z",
      recipient: { name: "Bo Example", address: "bo@example.org" },
      subject: "Lunch",
    },
  ],
  tasksDue: [
    { id: "task-1", accountId: "acc-1", messageId: "m-1", threadId: "th-1", title: "Sign the form", due: "2026-11-16", doneAt: null, createdAt: "2026-11-15T09:00:00.000Z", note: null },
  ],
  since: { notifications: 14, newsletters: 9, bills: 0, bulk: 2, personal: 0, from: "2026-11-15T08:00:00.000Z" },
  digestDay: "2026-11-16",
  dev: { ciFailed: 0, repos: 0, alertsFiring: 0 },
  rulesReady: 0,
};

function mount(overrides: Partial<Parameters<typeof TodayView>[0]> = {}) {
  const fake = fakePorts({ result: { kind: "digest", ...BASE, items: [{ threadId: "th-1", gist: HOSTILE }] } });
  const props = {
    load: vi.fn(async () => DATA),
    jobs: fake.ports,
    aiDisabledReason: null,
    onOpen: vi.fn(),
    onNoReply: vi.fn(async () => undefined),
    reminderDays: 3,
    onReminderSnooze: vi.fn(async () => undefined),
    onReminderDismiss: vi.fn(async () => undefined),
    onTaskDone: vi.fn(async () => undefined),
    onShowCategory: vi.fn(),
    pollMs: 0,
    ...overrides,
  };
  render(<TodayView {...props} />);
  return { ...props, calls: fake.calls };
}

describe("TodayView", () => {
  it("shows the four sections and acts on each", async () => {
    const props = mount();
    const needs = await screen.findByRole("region", { name: "Needs a reply" });
    fireEvent.click(within(needs).getByText("Ada Example"));
    expect(props.onOpen).toHaveBeenCalledWith("acc-1", "th-1");
    fireEvent.click(within(needs).getByRole("button", { name: "No reply needed" }));
    await waitFor(() => expect(props.onNoReply).toHaveBeenCalledWith("th-1"));
    await waitFor(() => expect(props.load).toHaveBeenCalledTimes(2));

    const waiting = screen.getByRole("region", { name: "Waiting for a reply" });
    fireEvent.click(within(waiting).getByRole("button", { name: "Remind in 3 days" }));
    expect(props.onReminderSnooze).toHaveBeenCalledWith(DATA.waiting[0], 3);
    fireEvent.click(within(waiting).getByRole("button", { name: "Dismiss" }));
    expect(props.onReminderDismiss).toHaveBeenCalledWith(DATA.waiting[0]);

    const tasks = screen.getByRole("region", { name: "Tasks due" });
    fireEvent.click(within(tasks).getByRole("button", { name: "Done" }));
    expect(props.onTaskDone).toHaveBeenCalledWith(DATA.tasksDue[0]);

    const since = screen.getByRole("region", { name: "Since yesterday" });
    fireEvent.click(within(since).getByRole("button", { name: "14 notifications" }));
    expect(props.onShowCategory).toHaveBeenCalledWith("notifications");
    expect(within(since).getByText("2 from mailing lists")).toBeTruthy();
    expect(within(since).queryByText(/bills/)).toBeNull();
  });

  it("Summarize puts each gist under its row as text", async () => {
    const props = mount();
    await screen.findByRole("region", { name: "Needs a reply" });
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    expect(await screen.findByText(HOSTILE)).toBeTruthy();
    expect(props.calls.start).toEqual([{ kind: "digest" }]);
    expect(document.querySelector("section a, section b")).toBeNull();
  });

  it("Summarize is off without Makosh AI; links are plain text with categories off", async () => {
    mount({ aiDisabledReason: "AI features need the Makosh AI plugin", onShowCategory: undefined });
    await screen.findByRole("region", { name: "Needs a reply" });
    expect((screen.getByRole("button", { name: "Summarize" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "14 notifications" })).toBeNull();
    expect(screen.getByText("14 notifications")).toBeTruthy();
  });
});
