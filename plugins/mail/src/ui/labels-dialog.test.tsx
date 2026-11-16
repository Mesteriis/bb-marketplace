// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelChips } from "./label-chips.tsx";
import { initialChoices, labelChanges, LabelsDialog } from "./labels-dialog.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const LABELS = [
  { name: "\\Inbox", path: null },
  { name: "\\Starred", path: null },
  { name: "Travel", path: "Travel" },
  { name: "Receipts", path: "Receipts" },
  { name: "[Gmail]/Important", path: null },
];

describe("LabelChips", () => {
  it("shows up to three owner labels and the rest as +n; system labels never", () => {
    render(<LabelChips labels={["\\Inbox", "Travel", "Receipts", "Work", "Family", "Home"]} />);
    const list = screen.getByRole("list", { name: "Labels" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Travel",
      "Receipts",
      "Work",
      "+2 more labels",
    ]);
  });

  it("renders nothing without owner labels", () => {
    const { container } = render(<LabelChips labels={["\\Inbox", "\\Important"]} />);
    expect(container.textContent).toBe("");
  });
});

describe("label changes", () => {
  it("starts on, off or mixed and sends only what changed", () => {
    const start = initialChoices(["Travel", "Receipts", "Work"], [["Travel", "Work"], ["Travel"]]);
    expect([...start]).toEqual([
      ["Travel", "on"],
      ["Receipts", "off"],
      ["Work", "mixed"],
    ]);
    const now = new Map(start).set("Travel", "off").set("Receipts", "on");
    expect(labelChanges(start, now)).toEqual({ add: ["Receipts"], remove: ["Travel"] });
    expect(labelChanges(start, start)).toEqual({ add: [], remove: [] });
  });
});

describe("LabelsDialog", () => {
  it("lists the owner's labels only, with the current ones checked", () => {
    render(
      <LabelsDialog
        request={{ count: 1, current: [["Travel", "\\Inbox"]] }}
        labels={LABELS}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: "Labels" });
    const names = within(list).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));
    expect(names).toEqual(["Receipts", "Travel"]);
    expect(screen.getByRole("checkbox", { name: "Travel" }).getAttribute("data-state")).toBe("checked");
  });

  it("validates a new label and applies it with the changes", async () => {
    const onApply = vi.fn(async () => {});
    render(
      <LabelsDialog
        request={{ count: 2, current: [["Travel"], ["Travel"]] }}
        labels={LABELS}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New label\u2026" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), { target: { value: "Spam" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe("That name is one of Gmail's own labels");
    fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), { target: { value: "\\Custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe("That name is one of Gmail's own labels");
    fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), { target: { value: "  Projects  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Travel" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ add: ["Projects"], remove: ["Travel"] }));
  });

  it("shows a refused change and stays open", async () => {
    render(
      <LabelsDialog
        request={{ count: 1, current: [[]] }}
        labels={LABELS}
        onApply={() => Promise.reject(new Error("Sync this account first"))}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Receipts" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Sync this account first"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("filters the list", () => {
    render(<LabelsDialog request={{ count: 1, current: [[]] }} labels={LABELS} onApply={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter labels" }), { target: { value: "rec" } });
    expect(within(screen.getByRole("list", { name: "Labels" })).getAllByRole("checkbox")).toHaveLength(1);
  });
});
