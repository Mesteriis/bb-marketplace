// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutSheet } from "./shortcut-sheet.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const CMD = String.fromCharCode(0x2318);
const SHIFT = String.fromCharCode(0x21e7);

function rowOf(label: string): HTMLElement {
  const term = screen.getByText(label);
  return term.closest("div") as HTMLElement;
}

describe("ShortcutSheet (slice 3i part B)", () => {
  it("shows the Apple Mail chords on a Mac", () => {
    render(<ShortcutSheet open onOpenChange={() => {}} mac />);
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("On a Mac, Apple Mail keys work too.")).toBeTruthy();
    expect(within(rowOf("Reply")).getByText(`${CMD}R`)).toBeTruthy();
    expect(within(rowOf("Reply all")).getByText(`${SHIFT}${CMD}R`)).toBeTruthy();
    expect(within(rowOf("Undo the last action")).getByText(`${CMD}Z`)).toBeTruthy();
    // A Mac-only row shows its chord.
    expect(within(rowOf("Mark read or unread")).getByText(`${SHIFT}${CMD}U`)).toBeTruthy();
    // The keys every platform has stay.
    expect(within(rowOf("Reply")).getByText("r")).toBeTruthy();
    expect(within(rowOf("Delete, as #")).getByText("Backspace")).toBeTruthy();
  });

  it("hides the Apple Mail chords elsewhere", () => {
    render(<ShortcutSheet open onOpenChange={() => {}} mac={false} />);
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).queryByText(`${CMD}R`)).toBeNull();
    expect(within(sheet).queryByText(/\u2318/)).toBeNull();
    expect(within(sheet).queryByText("Mark read or unread")).toBeNull();
    // The arrows and Backspace/Delete work on every platform.
    expect(within(rowOf("Reply")).getByText("r")).toBeTruthy();
    expect(within(rowOf("Delete, as #")).getByText("Delete")).toBeTruthy();
    expect(within(sheet).getByText("Select the next conversation too")).toBeTruthy();
    expect(within(sheet).getByText("Open the next or previous conversation")).toBeTruthy();
  });
});
