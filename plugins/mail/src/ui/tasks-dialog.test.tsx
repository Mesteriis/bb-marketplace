// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiResultView } from "../core/model.ts";
import { TasksDialog, editableTitle, picksOf, rowsOf } from "./tasks-dialog.tsx";
import { BASE, HOSTILE, fakePorts } from "./testing/ai-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const TASKS: Extract<AiResultView, { kind: "tasks" }> = {
  kind: "tasks",
  ...BASE,
  tasks: [
    { index: 0, title: "Send the signed form", due: "2026-11-20", message: 1, evidence: "please send the signed form", evidenceFound: true },
    { index: 1, title: HOSTILE, due: null, message: 2, evidence: "made-up quote", evidenceFound: false },
  ],
};

function mount(onKeep = vi.fn(async () => 1)) {
  const fake = fakePorts({ result: TASKS });
  const onClose = vi.fn();
  const onCite = vi.fn();
  render(
    <TasksDialog
      request={{ kind: "tasks", threadId: "th-1", folder: "INBOX" }}
      ports={fake.ports}
      onKeep={onKeep}
      onCite={onCite}
      onClose={onClose}
      pollMs={0}
    />,
  );
  return { ...fake, onKeep, onClose, onCite };
}

describe("TasksDialog", () => {
  it("ticks found tasks, leaves a missing quote unticked and warns", async () => {
    const { calls } = mount();
    const list = await screen.findByRole("list", { name: "Tasks found" });
    expect(calls.start).toEqual([{ kind: "tasks", threadId: "th-1", folder: "INBOX" }]);
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes[0]!.getAttribute("aria-checked")).toBe("true");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Quote not found in the message; check it before keeping.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep 1 task" })).toBeTruthy();
    // The model's title is a value, never markup.
    expect((screen.getByLabelText("Task 2 title") as HTMLInputElement).value).toBe(HOSTILE);
    expect(document.querySelector("[role=dialog] a, [role=dialog] b")).toBeNull();
  });

  it("keeps the ticked tasks with the owner's edits", async () => {
    const { onKeep, onClose } = mount();
    await screen.findByRole("list", { name: "Tasks found" });
    fireEvent.change(screen.getByLabelText("Task 1 title"), { target: { value: "Send the form today" } });
    fireEvent.change(screen.getByLabelText("Task 1 due date"), { target: { value: "2026-11-21" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep task 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep 2 tasks" }));
    await waitFor(() => expect(onKeep).toHaveBeenCalled());
    expect(onKeep).toHaveBeenCalledWith("job-1", [
      { index: 0, title: "Send the form today", due: "2026-11-21" },
      { index: 1, title: HOSTILE, due: null },
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a refused Keep says why and stays open", async () => {
    const { onClose } = mount(vi.fn(async () => {
      throw new Error("These tasks are no longer available; find tasks again");
    }));
    await screen.findByRole("list", { name: "Tasks found" });
    fireEvent.click(screen.getByRole("button", { name: "Keep 1 task" }));
    expect((await screen.findByRole("alert")).textContent).toBe("These tasks are no longer available; find tasks again");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the quote's chip opens the cited message", async () => {
    const { onCite } = mount();
    await screen.findByRole("list", { name: "Tasks found" });
    fireEvent.click(screen.getByRole("button", { name: "Open cited message 2" }));
    expect(onCite).toHaveBeenCalledWith(BASE.citations[1]);
  });

  it("titles become one line within the cap; picks drop empty titles and bad dates", () => {
    expect(editableTitle("a\nb\u200b  c")).toBe("a b c");
    expect(editableTitle("x".repeat(200))).toHaveLength(120);
    const rows = rowsOf(TASKS);
    expect(picksOf([{ ...rows[0]!, due: "soon" }, { ...rows[1]!, picked: true, title: "  " }])).toEqual([
      { index: 0, title: "Send the signed form", due: null },
    ]);
  });
});
