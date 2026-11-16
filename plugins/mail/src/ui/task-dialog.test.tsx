// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BB_TEXT } from "./bb-ports.ts";
import { TaskDialog, type TaskRequest } from "./task-dialog.tsx";
import { fakeCall, type BbHandlers } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

const BOARDS = {
  taskboard: { boards: [{ id: "b-1", name: "Personal" }, { id: "b-2", name: "Work" }] },
  reason: null,
  lastBoardId: "b-2",
  target: "auto" as const,
};

function mount(request: Partial<TaskRequest> = {}, handlers: BbHandlers = {}) {
  const fake = fakeCall({
    task_targets: () => BOARDS,
    task_from_mail: (input) => ({ kind: input.target.kind, taskId: "t-1" }),
    ...handlers,
  });
  const props = { onMade: vi.fn(), onClose: vi.fn() };
  render(<TaskDialog request={{ messageId: "m-1", subject: "Quarterly plan", inAiScope: true, ...request }} call={fake.call} {...props} />);
  return { ...fake, ...props };
}

describe("TaskDialog", () => {
  it("makes a task on the last used Taskboard board with the title, note and excerpt", async () => {
    const { to, onMade } = mount();
    const board = (await screen.findByLabelText("Board")) as HTMLSelectElement;
    expect(board.value).toBe("b-2");
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "Ask Ada first" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onMade).toHaveBeenCalled());
    expect(to("task_from_mail")[0]).toEqual({
      messageId: "m-1",
      target: { kind: "taskboard", boardId: "b-2" },
      title: "Quarterly plan",
      note: "Ask Ada first",
      excerpt: true,
    });
    expect(onMade.mock.calls[0]![1]).toBe("Work");
  });

  it("offers Mail's own task when Taskboard does not answer on Create", async () => {
    const { to, onMade } = mount(
      {},
      {
        task_from_mail: (input) =>
          input.target.kind === "taskboard" ? { kind: "unavailable", reason: "Taskboard did not answer" } : { kind: "local", taskId: "t-9" },
      },
    );
    await screen.findByLabelText("Board");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Taskboard did not answer; keep the task in Mail?");
    fireEvent.click(screen.getByRole("button", { name: "Keep it in Mail" }));
    await waitFor(() => expect(onMade).toHaveBeenCalledWith({ kind: "local", taskId: "t-9" }, null));
    expect(to("task_from_mail")[1]).toMatchObject({ target: { kind: "local", due: null } });
  });

  it("without Taskboard keeps a local task with a due date", async () => {
    const { to } = mount({}, { task_targets: () => ({ taskboard: null, reason: "Taskboard is not installed", lastBoardId: null, target: "auto" }) });
    expect(await screen.findByText("Taskboard is not installed; the task is kept in Mail.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Due (optional)"), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(to("task_from_mail")).toHaveLength(1));
    expect(to("task_from_mail")[0]).toMatchObject({ target: { kind: "local", due: "2026-11-20" } });
  });

  it("shows Taskboard's own refusal", async () => {
    mount({}, { task_from_mail: () => Promise.reject(new Error("Taskboard: The board was not found")) });
    await screen.findByLabelText("Board");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Taskboard: The board was not found");
  });

  it("out of AI access: Taskboard and the excerpt are off, the local task stays", async () => {
    const { to } = mount({ inAiScope: false });
    await screen.findByText(`Taskboard (${BB_TEXT.out_of_scope})`);
    expect((screen.getByRole("checkbox") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(to("task_from_mail")).toHaveLength(1));
    expect(to("task_from_mail")[0]).toMatchObject({ target: { kind: "local" }, excerpt: false });
  });
});
