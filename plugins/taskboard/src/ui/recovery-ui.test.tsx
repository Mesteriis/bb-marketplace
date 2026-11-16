// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TimeEntry } from "../core/index.ts";
import type { TaskboardApi } from "./api.ts";
import { TaskboardPage } from "./taskboard-page.tsx";

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

const columns = [{ id: "c1", boardId: "b", name: "To do", order: 0 }];
const board = { id: "b", name: "Board", connectionId: null, columns };
const task = { id: "t", boardId: "b", title: "Task", description: "", status: "c1", origin: "local" as const, originKey: null, originUrl: null, labels: [], createdAt: "x", updatedAt: "x", sortOrder: 0 };

function fakeApi(overrides: Partial<TaskboardApi>): TaskboardApi {
  return {
    listBoards: async () => [board],
    listConnections: async () => [],
    listTasks: async () => ({ columns, tasks: [task] }),
    createBoard: async () => { throw new Error("u"); }, updateBoard: async () => { throw new Error("u"); }, deleteBoard: async () => {},
    createTask: async () => { throw new Error("u"); }, updateTask: async () => { throw new Error("u"); }, moveTask: async () => task, deleteTask: async () => {},
    createConnection: async () => { throw new Error("u"); }, updateConnection: async () => { throw new Error("u"); }, deleteConnection: async () => {}, testConnection: async () => {},
    fetchIssues: async () => ({ imported: 0, total: null, truncated: false }),
    listTransitions: async () => [], applyTransition: async () => task,
    listProjects: async () => [], takeIntoWork: async () => { throw new Error("u"); }, cancelRun: async () => undefined, listRuns: async () => [], completeRun: async () => { throw new Error("u"); },
    updateTimeEntry: async () => { throw new Error("u"); }, submitTimeEntry: async () => { throw new Error("u"); }, listPendingTimeEntries: async () => [],
    listTimeEntriesByTask: async () => [], retryTimeEntry: async () => { throw new Error("u"); }, resolveTimeEntry: async () => { throw new Error("u"); },
    ...overrides,
  } as TaskboardApi;
}

function entry(state: TimeEntry["state"]): TimeEntry {
  return { id: "e1", runId: "r1", taskId: "t", state, durationSeconds: 1200, comment: "edited", createdAtIso: "x", submittedAtIso: null };
}

describe("time recovery UI", () => {
  it("shows a failed entry and retries it (failed-only)", async () => {
    const retry = vi.fn(async () => entry("pending"));
    const api = fakeApi({ listTimeEntriesByTask: async () => [entry("failed")], retryTimeEntry: retry });
    render(<TaskboardPage api={api} />);
    fireEvent.click(await screen.findByText("Task"));
    expect(await screen.findByText("Time submission failed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry time" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("e1"));
  });

  it("shows an unknown entry and resolves it without a POST", async () => {
    const resolve = vi.fn(async () => ({ id: "w1", taskId: "t", runId: "r1", remote: true, remoteId: null, durationSeconds: 1200, comment: "edited", startedAtIso: "x", createdAtIso: "y" }));
    const api = fakeApi({ listTimeEntriesByTask: async () => [entry("unknown")], resolveTimeEntry: resolve });
    render(<TaskboardPage api={api} />);
    fireEvent.click(await screen.findByText("Task"));
    expect(await screen.findByText(/may already be logged/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark logged" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ entryId: "e1" }));
  });
});
