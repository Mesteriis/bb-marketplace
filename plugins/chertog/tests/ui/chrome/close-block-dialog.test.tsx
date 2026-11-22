// The one question asked before a parent tile closes together with its linked tiles.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CloseBlockDialog } from "../../../src/ui/chrome/index.ts";

function setup(open = true) {
  const calls = { onConfirm: vi.fn<() => void>(), onCancel: vi.fn<() => void>() };
  render(<CloseBlockDialog open={open} panelTitle="Родитель" linkedCount={2} {...calls} />);
  return calls;
}

describe("CloseBlockDialog", () => {
  it("renders nothing while closed", () => {
    setup(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the parent and the number of linked tiles, and starts on the safe choice", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Закрыть вместе с подчинёнными (2)?" })).toBeTruthy();
    expect(screen.getByText(/«Родитель»/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отмена" }));
  });

  it("confirms with the close button", async () => {
    const calls = setup();
    await userEvent.click(screen.getByRole("button", { name: "Закрыть всё" }));
    expect(calls.onConfirm).toHaveBeenCalledTimes(1);
    expect(calls.onCancel).not.toHaveBeenCalled();
  });

  it("cancels with Escape and changes nothing", async () => {
    const calls = setup();
    await userEvent.keyboard("{Escape}");
    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.onConfirm).not.toHaveBeenCalled();
  });
});
