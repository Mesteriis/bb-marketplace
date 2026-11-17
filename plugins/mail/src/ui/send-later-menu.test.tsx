// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLaterPresets, validSendAt } from "../core/send-later.ts";
import { SendLaterMenu } from "./send-later-menu.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function labels() {
  return within(screen.getByRole("list", { name: "Send times" }))
    .getAllByRole("button")
    .map((b) => b.firstElementChild?.textContent ?? b.textContent);
}

describe("SendLaterMenu (slice 3l)", () => {
  it("a weekday morning offers every preset; a pick sends the local time as UTC ISO", () => {
    // Tuesday 10:15 local.
    const now = new Date(2026, 10, 17, 10, 15);
    const onPick = vi.fn();
    render(<SendLaterMenu open onOpenChange={vi.fn()} onPick={onPick} now={() => now} />);
    expect(labels()).toEqual([
      "In an hour",
      "This evening",
      "Tomorrow morning",
      "Tomorrow afternoon",
      "Monday morning",
      "Pick a date and time",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^In an hour/ }));
    expect(onPick).toHaveBeenLastCalledWith(new Date(2026, 10, 17, 11, 15).toISOString());
    fireEvent.click(screen.getByRole("button", { name: /^This evening/ }));
    expect(onPick).toHaveBeenLastCalledWith(new Date(2026, 10, 17, 18, 0).toISOString());
    fireEvent.click(screen.getByRole("button", { name: /^Tomorrow afternoon/ }));
    expect(onPick).toHaveBeenLastCalledWith(new Date(2026, 10, 18, 13, 0).toISOString());
    fireEvent.click(screen.getByRole("button", { name: /^Monday morning/ }));
    expect(onPick).toHaveBeenLastCalledWith(new Date(2026, 10, 23, 8, 0).toISOString());
  });

  it("an evening hides This evening; a Sunday hides Monday morning", () => {
    const ids = (now: Date) => sendLaterPresets(now).map((preset) => preset.id);
    expect(ids(new Date(2026, 10, 17, 17, 0))).toEqual(["in_an_hour", "tomorrow_morning", "tomorrow_afternoon", "monday_morning"]);
    expect(ids(new Date(2026, 10, 22, 9, 0))).toEqual(["in_an_hour", "this_evening", "tomorrow_morning", "tomorrow_afternoon"]);
  });

  it("Pick a date and time takes a local moment in range and refuses one outside it", () => {
    const now = new Date(2026, 10, 17, 10, 15);
    const onPick = vi.fn();
    render(<SendLaterMenu open onOpenChange={vi.fn()} onPick={onPick} now={() => now} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick a date and time" }));
    const input = screen.getByLabelText("Send at") as HTMLInputElement;
    expect(input.value).toBe("2026-11-17T11:15");
    fireEvent.change(input, { target: { value: "2026-11-17T10:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick a time from one minute to a year from now.");
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2026-11-20T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 10, 20, 9, 30).toISOString());
  });

  it("accepts one minute to 365 days ahead", () => {
    const now = new Date("2026-11-17T10:00:00.000Z");
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    expect(validSendAt(at(60_000), now)).toBe(true);
    expect(validSendAt(at(59_999), now)).toBe(false);
    expect(validSendAt(at(365 * 86_400_000), now)).toBe(true);
    expect(validSendAt(at(365 * 86_400_000 + 1), now)).toBe(false);
    expect(validSendAt("soon", now)).toBe(false);
  });
});
