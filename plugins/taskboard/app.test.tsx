// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BoardView, Column, Task } from "./src/core/index.ts";
import type { Notify, TaskboardApi } from "./src/ui/api.ts";
import { TaskboardPage } from "./src/ui/taskboard-page.tsx";

function column(id: string, name: string, order: number): Column {
  return { id, boardId: "b1", name, order };
}

function task(id: string, title: string, status: string): Task {
  return {
    id, boardId: "b1", title, description: "", status, origin: "local", originKey: null,
    originUrl: null, labels: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0,
  };
}

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

function fakeApi(overrides: Partial<TaskboardApi> = {}): TaskboardApi {
  return {
    listBoards: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    listTasks: vi.fn(async () => ({ columns: [], tasks: [] })),
    createBoard: vi.fn(async () => { throw new Error("unexpected"); }),
    updateBoard: vi.fn(async () => { throw new Error("unexpected"); }),
    deleteBoard: vi.fn(async () => undefined),
    createTask: vi.fn(async () => { throw new Error("unexpected"); }),
    updateTask: vi.fn(async () => { throw new Error("unexpected"); }),
    moveTask: vi.fn(async (taskId, status) => task(taskId, "", status)),
    deleteTask: vi.fn(async () => undefined),
    createConnection: vi.fn(async () => { throw new Error("unexpected"); }),
    updateConnection: vi.fn(async () => { throw new Error("unexpected"); }),
    deleteConnection: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => undefined),
    fetchIssues: vi.fn(async () => ({ imported: 0, total: null, truncated: false })),
    listTransitions: vi.fn(async () => []),
    applyTransition: vi.fn(async () => { throw new Error("unexpected"); }),
    listProjects: vi.fn(async () => []),
    takeIntoWork: vi.fn(async () => { throw new Error("unexpected"); }),
    cancelRun: vi.fn(async () => undefined),
    listRuns: vi.fn(async () => []),
    completeRun: vi.fn(async () => { throw new Error("unexpected"); }),
    updateTimeEntry: vi.fn(async () => { throw new Error("unexpected"); }),
    submitTimeEntry: vi.fn(async () => { throw new Error("unexpected"); }),
    listPendingTimeEntries: vi.fn(async () => []),
    listTimeEntriesByTask: vi.fn(async () => []),
    retryTimeEntry: vi.fn(async () => { throw new Error("unexpected"); }),
    resolveTimeEntry: vi.fn(async () => { throw new Error("unexpected"); }),
    ...overrides,
  };
}

describe("TaskboardPage", () => {
  it("shows the empty state when there are no boards", async () => {
    render(<TaskboardPage api={fakeApi()} />);
    expect(await screen.findByText("No boards yet.")).toBeTruthy();
  });

  it("renders a board's tasks", async () => {
    const board: BoardView = { id: "b1", name: "Board", connectionId: null, columns: [column("c1", "To do", 0)] };
    const api = fakeApi({
      listBoards: vi.fn(async () => [board]),
      listTasks: vi.fn(async () => ({ columns: board.columns, tasks: [task("t1", "Write tests", "c1")] })),
    });
    render(<TaskboardPage api={api} />);
    expect(await screen.findByText("Write tests")).toBeTruthy();
  });

  it("rolls back an optimistic move that the server rejects", async () => {
    const columns = [column("c1", "To do", 0), column("c2", "Done", 1)];
    const board: BoardView = { id: "b1", name: "Board", connectionId: null, columns };
    const notify: Notify = vi.fn();
    const api = fakeApi({
      listBoards: vi.fn(async () => [board]),
      listTasks: vi.fn(async () => ({ columns, tasks: [task("t1", "Write tests", "c1")] })),
      moveTask: vi.fn(async () => { throw new Error("No Jira transition leads to this column"); }),
    });
    render(<TaskboardPage api={api} notify={notify} />);
    await screen.findByText("Write tests");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const select = await screen.findByLabelText("Move task");
    fireEvent.change(select, { target: { value: "c2" } });
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c1"));
    expect(notify).toHaveBeenCalledWith("error", "No Jira transition leads to this column");
  });
});
