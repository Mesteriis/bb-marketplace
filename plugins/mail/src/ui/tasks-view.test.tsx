// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "../core/model.ts";
import { TASK_GONE_TEXT, TasksView, byDue } from "./tasks-view.tsx";

installTestPluginRuntime();
afterEach(cleanup);

const task = (id: string, due: string | null, overrides: Partial<TaskView> = {}): TaskView => ({
  id,
  accountId: "acc-1",
  messageId: `m-${id}`,
  threadId: `th-${id}`,
  title: `Task ${id}`,
  due,
  doneAt: null,
  createdAt: `2026-11-1${id.length}T09:00:00.000Z`,
  note: null,
  ...overrides,
});

function mount(tasks: TaskView[]) {
  const props = {
    load: vi.fn(async (done: boolean) => ({ tasks: done ? [] : tasks, next: null })),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    onOpen: vi.fn(),
  };
  render(<TasksView {...props} />);
  return props;
}

describe("TasksView", () => {
  it("orders by due date, no date last", () => {
    expect(byDue([task("a", null), task("b", "2026-11-20"), task("c", "2026-11-18")]).map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("lists open tasks with Done, Edit, Delete and the message link", async () => {
    const gone = task("g", null, { messageId: null, threadId: null });
    const props = mount([task("a", "2026-11-20"), gone]);
    const list = await screen.findByRole("list", { name: "Tasks" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Task a");
    expect(within(rows[1]!).getByText(TASK_GONE_TEXT)).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open the message" }));
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    fireEvent.click(within(rows[0]!).getByRole("checkbox", { name: "Done: Task a" }));
    await waitFor(() => expect(props.update).toHaveBeenCalledWith("a", { done: true }));

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Task a, edited" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-11-25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.update).toHaveBeenCalledWith("a", { title: "Task a, edited", due: "2026-11-25" }));

    const second = within(await screen.findByRole("list", { name: "Tasks" })).getAllByRole("listitem")[1]!;
    fireEvent.click(within(second).getByRole("button", { name: "Delete" }));
    expect(props.remove).not.toHaveBeenCalled();
    fireEvent.click(within(second).getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(props.remove).toHaveBeenCalledWith("g"));
  });

  it("the Done filter lists finished tasks", async () => {
    const props = mount([task("a", null)]);
    await screen.findByRole("list", { name: "Tasks" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(props.load).toHaveBeenLastCalledWith(true, null));
    expect(await screen.findByText("No finished tasks.")).toBeTruthy();
  });
});
