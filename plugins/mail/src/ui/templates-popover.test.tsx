// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatesPopover } from "./templates-popover.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const TEMPLATES = [
  { id: "a", name: "Thanks", doc: doc("Thank you, made up."), updatedAt: "2026-11-10T09:00:00.000Z" },
  { id: "b", name: "Follow-up", doc: doc("Following up, invented."), updatedAt: "2026-11-10T09:00:00.000Z" },
  { id: "c", name: "Thanks again", doc: doc("Again, invented."), updatedAt: "2026-11-10T09:00:00.000Z" },
];

function mount() {
  const props = { onInsert: vi.fn(), onManage: vi.fn(), onClose: vi.fn() };
  render(<TemplatesPopover templates={TEMPLATES} {...props} />);
  return { ...props, find: screen.getByRole("combobox", { name: "Find a template" }) };
}

describe("TemplatesPopover", () => {
  it("filters by name, moves with the arrows and inserts with Enter", () => {
    const { find, onInsert } = mount();
    expect(document.activeElement).toBe(find);
    fireEvent.change(find, { target: { value: "thanks" } });
    expect(screen.getAllByRole("option").map((o) => o.firstChild?.textContent)).toEqual(["Thanks", "Thanks again"]);
    fireEvent.keyDown(find, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(find, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith(TEMPLATES[2]);
  });

  it("a click inserts; Escape closes; Cmd+Enter does not insert; no match says so", () => {
    const { find, onInsert, onClose, onManage } = mount();
    fireEvent.keyDown(find, { key: "Enter", metaKey: true });
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /Follow-up/ }));
    expect(onInsert).toHaveBeenCalledWith(TEMPLATES[1]);
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(screen.getByText("No template has this name.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage templates…" }));
    expect(onManage).toHaveBeenCalled();
    fireEvent.keyDown(find, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
