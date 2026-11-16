// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDateTimeValue, parseLocalDateTime, SNOOZE_RANGE_TEXT, SnoozeMenu } from "./snooze-menu.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function labels() {
  return within(screen.getByRole("list", { name: "Snooze times" }))
    .getAllByRole("button")
    .map((b) => b.firstElementChild?.textContent ?? b.textContent);
}

describe("SnoozeMenu", () => {
  it("a weekday morning offers every preset; a pick sends the local time as UTC ISO", () => {
    // Tuesday 10:15 local.
    const now = new Date(2026, 10, 17, 10, 15);
    const onPick = vi.fn();
    render(<SnoozeMenu open onOpenChange={vi.fn()} onPick={onPick} now={() => now} />);
    expect(labels()).toEqual(["Later today", "Tomorrow", "This weekend", "Next week", "Pick a date and time"]);
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow/ }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 10, 18, 8, 0).toISOString());
    fireEvent.click(screen.getByRole("button", { name: /^Later today/ }));
    expect(onPick).toHaveBeenLastCalledWith(new Date(2026, 10, 17, 14, 0).toISOString());
  });

  it("an evening hides Later today; a weekend hides This weekend", () => {
    const evening = new Date(2026, 10, 17, 19, 0);
    const { unmount } = render(<SnoozeMenu open onOpenChange={vi.fn()} onPick={vi.fn()} now={() => evening} />);
    expect(labels()).toEqual(["Tomorrow", "This weekend", "Next week", "Pick a date and time"]);
    unmount();
    const saturday = new Date(2026, 10, 21, 9, 0);
    render(<SnoozeMenu open onOpenChange={vi.fn()} onPick={vi.fn()} now={() => saturday} />);
    expect(labels()).toEqual(["Later today", "Tomorrow", "Next week", "Pick a date and time"]);
  });

  it("Pick a date and time takes a local moment in range and refuses one outside it", () => {
    const now = new Date(2026, 10, 17, 10, 15);
    const onPick = vi.fn();
    render(<SnoozeMenu open onOpenChange={vi.fn()} onPick={onPick} now={() => now} count={3} />);
    expect(screen.getByRole("heading", { name: "Snooze 3 conversations until…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick a date and time" }));
    const input = screen.getByLabelText("Snooze until") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-11-17T10:16" } });
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(screen.getByRole("alert").textContent).toBe(SNOOZE_RANGE_TEXT);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2026-11-20T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 10, 20, 9, 30).toISOString());
  });

  it("reads and writes datetime-local values in local time", () => {
    expect(parseLocalDateTime("2026-02-30T08:00")).toBeNull();
    expect(parseLocalDateTime("soon")).toBeNull();
    const date = new Date(2026, 0, 5, 7, 4);
    expect(localDateTimeValue(date)).toBe("2026-01-05T07:04");
    expect(parseLocalDateTime("2026-01-05T07:04")?.getTime()).toBe(date.getTime());
  });
});
