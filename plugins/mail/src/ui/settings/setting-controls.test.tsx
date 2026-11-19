// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SETTING_DEFAULTS, type PageSettings, type PageSettingsPatch } from "../../core/page-settings.ts";
import { NumberSetting, ReadOnlySetting, SwitchSetting, TextSetting, type PageSettingsPort, type SaveResult } from "./setting-controls.tsx";

installTestPluginRuntime();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A port whose saves are answered by hand, in the order the test chooses. */
function heldPort(values: PageSettings | null = PAGE_SETTING_DEFAULTS) {
  const calls: { patch: PageSettingsPatch; answer: (result: SaveResult) => void }[] = [];
  const port: PageSettingsPort = {
    values,
    save: (patch) => new Promise<SaveResult>((answer) => calls.push({ patch, answer })),
  };
  return { port, calls };
}

describe("SwitchSetting", () => {
  it("shows the saved value, saves the other on a click and says Saved for two seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port, calls } = heldPort();
    render(<SwitchSetting port={port} name="hideQuotes" label="Hide quoted text" hint="In replies." />);
    const control = screen.getByRole("switch", { name: "Hide quoted text" });
    expect(control.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(control);
    expect(calls.map((call) => call.patch)).toEqual([{ hideQuotes: false }]);
    expect(control.getAttribute("aria-checked")).toBe("false");

    await act(async () => calls[0]!.answer({ ok: true }));
    expect(screen.getByRole("status").textContent).toBe("Saved");
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a refused save puts the control back and says why", async () => {
    const { port, calls } = heldPort();
    render(<SwitchSetting port={port} name="hideQuotes" label="Hide quoted text" />);
    const control = screen.getByRole("switch");
    fireEvent.click(control);
    await act(async () => calls[0]!.answer({ ok: false, message: "BB did not save this setting" }));
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("BB did not save this setting");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("of two quick changes the second decides what the row says, even when the first answers later", async () => {
    const { port, calls } = heldPort();
    render(<SwitchSetting port={port} name="hideQuotes" label="Hide quoted text" />);
    const control = screen.getByRole("switch");
    fireEvent.click(control);
    fireEvent.click(control);
    expect(calls.map((call) => call.patch)).toEqual([{ hideQuotes: false }, { hideQuotes: true }]);

    await act(async () => calls[1]!.answer({ ok: false, message: "BB did not save this setting" }));
    await act(async () => calls[0]!.answer({ ok: true }));
    expect(screen.getByRole("alert").textContent).toBe("BB did not save this setting");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a save that throws is a refusal too", async () => {
    const port: PageSettingsPort = { values: PAGE_SETTING_DEFAULTS, save: () => Promise.reject(new Error("offline")) };
    render(<SwitchSetting port={port} name="hideQuotes" label="Hide quoted text" />);
    fireEvent.click(screen.getByRole("switch"));
    expect((await screen.findByRole("alert")).textContent).toBe("The setting could not be saved.");
  });

  it("is disabled and says Loading while the settings load", () => {
    const { port, calls } = heldPort(null);
    render(<SwitchSetting port={port} name="hideQuotes" label="Hide quoted text" />);
    const control = screen.getByRole("switch") as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    fireEvent.click(control);
    expect(calls).toEqual([]);
  });
});

describe("NumberSetting and TextSetting", () => {
  it("a number saves on Enter and on leaving the field, not on each keystroke", async () => {
    const { port, calls } = heldPort();
    render(<NumberSetting port={port} name="replyReminderDays" label="Remind after" unit="days" />);
    const field = screen.getByLabelText("Remind after") as HTMLInputElement;
    expect(field.value).toBe("3");

    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.change(field, { target: { value: "14" } });
    expect(calls).toEqual([]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(calls.map((call) => call.patch)).toEqual([{ replyReminderDays: 14 }]);

    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    expect(calls.map((call) => call.patch)).toEqual([{ replyReminderDays: 14 }, { replyReminderDays: 5 }]);
  });

  it("an empty or fractional number is not sent, and leaving the value as it was sends nothing", async () => {
    const { port, calls } = heldPort();
    render(<NumberSetting port={port} name="replyReminderDays" label="Remind after" />);
    const field = screen.getByLabelText("Remind after");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number.");
    fireEvent.change(field, { target: { value: "2.5" } });
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.blur(field);
    expect(calls).toEqual([]);
  });

  it("text saves on leaving the field, and Escape drops what was typed", async () => {
    const { port, calls } = heldPort();
    render(<TextSetting port={port} name="quietHours" label="Quiet hours" placeholder="22:00-07:00" />);
    const field = screen.getByLabelText("Quiet hours") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "23:00-" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "22:00-07:00" } });
    fireEvent.blur(field);
    await waitFor(() => expect(calls.map((call) => call.patch)).toEqual([{ quietHours: "22:00-07:00" }]));
  });
});

describe("ReadOnlySetting", () => {
  it("shows the state and the way to BB's settings, and has no switch", () => {
    const open = vi.fn();
    render(<ReadOnlySetting label="Agents read mail" hint="In every thread." on={false} onOpenBbSettings={open} />);
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change in BB settings" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
