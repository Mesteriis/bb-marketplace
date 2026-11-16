// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyTransition,
  createBoard,
  createConnection,
  createTask,
  deleteBoard,
  deleteConnection,
  deleteTask,
  fetchIssues,
  jiraClientFor,
  listBoards,
  listConnections,
  listTasks,
  moveTask,
  updateBoard,
  updateConnection,
  updateTask,
  type FetchLike,
} from "../core/index.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "../core/testing/fakes.ts";
import type { TaskboardApi } from "./api.ts";
import { TaskboardPage } from "./taskboard-page.tsx";

beforeAll(() => installTestPluginRuntime());
afterEach(cleanup);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function cloudFetch(): FetchLike {
  return async (url, init) => {
    if (url.includes("/myself")) return json({ displayName: "Demo User" });
    if (url.includes("/search")) {
      return json({
        issues: [
          { key: "DEMO-101", fields: { summary: "Ship onboarding", status: { name: "To do", id: "1" }, issuetype: { name: "Task" }, labels: ["mobile"], assignee: null, description: "Onboard new users" } },
        ],
        nextPageToken: null,
      });
    }
    if (url.includes("/transitions")) return json({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] });
    throw new Error("unexpected " + url);
  };
}

function buildApi(fetchFn: FetchLike = cloudFetch()) {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock(new Date("2026-06-01T00:00:00.000Z"));
  const boardDeps = { store, idgen, clock };
  const connectionDeps = { store, credentials, idgen, clock };
  const syncDeps = { store, credentials, idgen, clock, fetchFn };
  const api: TaskboardApi = {
    listBoards: () => Promise.resolve(listBoards(boardDeps)),
    listConnections: () => Promise.resolve(listConnections(connectionDeps)),
    listTasks: (boardId) => Promise.resolve(listTasks(boardId, boardDeps)),
    createBoard: (name) => Promise.resolve(createBoard(name, boardDeps)),
    updateBoard: (input) => Promise.resolve(updateBoard(input, boardDeps)),
    deleteBoard: (id) => { deleteBoard(id, boardDeps); return Promise.resolve(); },
    createTask: (input) => Promise.resolve(createTask(input, boardDeps)),
    updateTask: (input) => Promise.resolve(updateTask(input, boardDeps)),
    moveTask: (taskId, status) => moveTask(taskId, status, syncDeps),
    deleteTask: (id) => { deleteTask(id, boardDeps); return Promise.resolve(); },
    createConnection: (input) => Promise.resolve(createConnection(input, connectionDeps)),
    updateConnection: (input) => Promise.resolve(updateConnection(input, connectionDeps)),
    deleteConnection: (id) => { deleteConnection(id, connectionDeps); return Promise.resolve(); },
    testConnection: async (id) => { await jiraClientFor(id, syncDeps).myself(); },
    fetchIssues: (id) => fetchIssues(id, syncDeps),
    listTransitions: (connectionId, issueKey) => jiraClientFor(connectionId, syncDeps).getTransitions(issueKey),
    applyTransition: (connectionId, issueKey, transitionId) => applyTransition(connectionId, issueKey, transitionId, syncDeps),
    listProjects: async () => [],
    takeIntoWork: async () => { throw new Error("unexpected"); },
    cancelRun: async () => undefined,
    listRuns: async () => [],
    completeRun: async () => { throw new Error("unexpected"); },
    updateTimeEntry: async () => { throw new Error("unexpected"); },
    submitTimeEntry: async () => { throw new Error("unexpected"); },
    listPendingTimeEntries: async () => [],
    listTimeEntriesByTask: async () => [],
    retryTimeEntry: async () => { throw new Error("unexpected"); },
    resolveTimeEntry: async () => { throw new Error("unexpected"); },
  };
  return { api, store, boardDeps, connectionDeps };
}

describe("taskboard end-to-end UI", () => {
  it("creates a connection, fetches issues, and shows them", async () => {
    const { api } = buildApi();
    render(<TaskboardPage api={api} />);
    await screen.findByText("No boards yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add Jira connection" }));
    fireEvent.click(screen.getByRole("button", { name: "New connection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo Cloud" } });
    fireEvent.change(screen.getByLabelText("HTTPS URL"), { target: { value: "https://example.atlassian.net" } });
    fireEvent.change(screen.getByLabelText("Account email"), { target: { value: "me@example.com" } });
    fireEvent.change(screen.getByLabelText("Project key"), { target: { value: "DEMO" } });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Connection saved; reopen the manager and fetch from it.
    fireEvent.click(await screen.findByRole("button", { name: "Add Jira connection" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    expect(await screen.findByText("Ship onboarding")).toBeTruthy();
    expect(screen.getByText("DEMO-101")).toBeTruthy();
  });

  it("applies an edited status through the real move path", async () => {
    const { api, boardDeps } = buildApi();
    const board = createBoard("Board", boardDeps);
    const done = board.columns[1].id;
    createTask({ boardId: board.id, title: "Local task", status: board.columns[0].id }, boardDeps);
    render(<TaskboardPage api={api} />);
    fireEvent.click(await screen.findByText("Local task"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: done } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const task = listTasks(board.id, boardDeps).tasks[0];
      expect(task.title).toBe("Renamed");
      expect(task.status).toBe(done);
    });
  });

  it("filters by search and origin", async () => {
    const { api } = buildApi();
    const connection = await api.createConnection({ name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "DEMO", jql: "", credential: "tok" });
    await api.fetchIssues(connection.id);
    const board = (await api.listBoards())[0];
    await api.createTask({ boardId: board.id, title: "Fix login bug", status: board.columns[0].id });
    render(<TaskboardPage api={api} />);
    await screen.findByText("Fix login bug");
    expect(screen.getByText("Ship onboarding")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "login" } });
    expect(screen.getByText("Fix login bug")).toBeTruthy();
    expect(screen.queryByText("Ship onboarding")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Origin filter"), { target: { value: "jira" } });
    await waitFor(() => expect(screen.getByText("Ship onboarding")).toBeTruthy());
    expect(screen.queryByText("Fix login bug")).toBeNull();
  });

  it("renames a column through board settings without losing tasks", async () => {
    const { api, boardDeps } = buildApi();
    const board = createBoard("Board", boardDeps);
    const task = createTask({ boardId: board.id, title: "Keep me", status: board.columns[0].id }, boardDeps);
    render(<TaskboardPage api={api} />);
    await screen.findByText("Keep me");
    fireEvent.click(screen.getByRole("button", { name: "Board settings" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Column 1 name"), { target: { value: "Backlog" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const result = listTasks(board.id, boardDeps);
      expect(result.columns[0].name).toBe("Backlog");
      expect(result.tasks.some((entry) => entry.id === task.id)).toBe(true);
    });
  });
});

describe("taskboard defensive UI", () => {
  it("clears the previous board's tasks when a board load fails", async () => {
    const boards = [
      { id: "a", name: "A", connectionId: null, columns: [{ id: "ca", boardId: "a", name: "To do", order: 0 }] },
      { id: "b", name: "B", connectionId: null, columns: [] },
    ];
    const api: TaskboardApi = {
      listBoards: vi.fn(async () => boards),
      listConnections: vi.fn(async () => []),
      listTasks: vi.fn(async (boardId) =>
        boardId === "a"
          ? { columns: boards[0].columns, tasks: [{ id: "t", boardId: "a", title: "Old task", description: "", status: "ca", origin: "local", originKey: null, originUrl: null, labels: [], createdAt: "x", updatedAt: "x", sortOrder: 0 }] }
          : Promise.reject(new Error("boom")),
      ),
      createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(),
      moveTask: vi.fn(), deleteTask: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(),
      testConnection: vi.fn(), fetchIssues: vi.fn(async () => ({ imported: 0, total: null, truncated: false })),
      listTransitions: vi.fn(async () => []), applyTransition: vi.fn(),
    } as unknown as TaskboardApi;
    render(<TaskboardPage api={api} />);
    await screen.findByText("Old task");
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "b" } });
    await waitFor(() => expect(screen.queryByText("Old task")).toBeNull());
  });

  it("serializes moves: both rejections reconcile to the confirmed status", async () => {
    const columns = [
      { id: "c1", boardId: "b", name: "To do", order: 0 },
      { id: "c2", boardId: "b", name: "Doing", order: 1 },
      { id: "c3", boardId: "b", name: "Done", order: 2 },
    ];
    const board = { id: "b", name: "Board", connectionId: null, columns };
    const serverStatus = { value: "c1" };
    const originalTask = { id: "t", boardId: "b", title: "Task", description: "", status: "c1", origin: "local" as const, originKey: null, originUrl: null, labels: [], createdAt: "x", updatedAt: "x", sortOrder: 0 };
    const api: TaskboardApi = {
      listBoards: vi.fn(async () => [board]),
      listConnections: vi.fn(async () => []),
      listTasks: vi.fn(async () => ({ columns, tasks: [{ ...originalTask, status: serverStatus.value }] })),
      moveTask: vi.fn(async () => { throw new Error("No Jira transition leads to this column"); }),
      createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(),
      deleteTask: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(),
      testConnection: vi.fn(), fetchIssues: vi.fn(async () => ({ imported: 0, total: null, truncated: false })),
      listTransitions: vi.fn(async () => []), applyTransition: vi.fn(),
    } as unknown as TaskboardApi;
    render(<TaskboardPage api={api} />);
    await screen.findByText("Task");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const select = await screen.findByLabelText("Move task");
    fireEvent.change(select, { target: { value: "c2" } });
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Move task"), { target: { value: "c3" } });
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c1"));
  });

  it("serializes moves: reject then success ends at the confirmed status", async () => {
    const columns = [
      { id: "c1", boardId: "b", name: "To do", order: 0 },
      { id: "c2", boardId: "b", name: "Doing", order: 1 },
      { id: "c3", boardId: "b", name: "Done", order: 2 },
    ];
    const board = { id: "b", name: "Board", connectionId: null, columns };
    const serverStatus = { value: "c1" };
    const originalTask = { id: "t", boardId: "b", title: "Task", description: "", status: "c1", origin: "local" as const, originKey: null, originUrl: null, labels: [], createdAt: "x", updatedAt: "x", sortOrder: 0 };
    const api: TaskboardApi = {
      listBoards: vi.fn(async () => [board]),
      listConnections: vi.fn(async () => []),
      listTasks: vi.fn(async () => ({ columns, tasks: [{ ...originalTask, status: serverStatus.value }] })),
      moveTask: vi.fn(async (taskId, status) => {
        if (status === "c2") throw new Error("No Jira transition leads to this column");
        serverStatus.value = status;
        return { ...originalTask, status };
      }),
      createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(),
      deleteTask: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(),
      testConnection: vi.fn(), fetchIssues: vi.fn(async () => ({ imported: 0, total: null, truncated: false })),
      listTransitions: vi.fn(async () => []), applyTransition: vi.fn(),
    } as unknown as TaskboardApi;
    render(<TaskboardPage api={api} />);
    await screen.findByText("Task");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.change(await screen.findByLabelText("Move task"), { target: { value: "c2" } });
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Move task"), { target: { value: "c3" } });
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c3"));
  });

  it("overlap: a second move while pending is blocked and rejection reconciles", async () => {
    const columns = [
      { id: "c1", boardId: "b", name: "To do", order: 0 },
      { id: "c2", boardId: "b", name: "Doing", order: 1 },
      { id: "c3", boardId: "b", name: "Done", order: 2 },
    ];
    const board = { id: "b", name: "Board", connectionId: null, columns };
    let rejectMove: (e: Error) => void = () => {};
    const pendingMove = new Promise<never>((_, reject) => { rejectMove = reject; });
    const serverStatus = { value: "c1" };
    const originalTask = { id: "t", boardId: "b", title: "Task", description: "", status: "c1", origin: "local" as const, originKey: null, originUrl: null, labels: [], createdAt: "x", updatedAt: "x", sortOrder: 0 };
    const moveCalls: string[] = [];
    const api: TaskboardApi = {
      listBoards: vi.fn(async () => [board]),
      listConnections: vi.fn(async () => []),
      listTasks: vi.fn(async () => ({ columns, tasks: [{ ...originalTask, status: serverStatus.value }] })),
      moveTask: vi.fn(async (taskId, status) => { moveCalls.push(status); return pendingMove; }),
      createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(),
      deleteTask: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn(), deleteConnection: vi.fn(),
      testConnection: vi.fn(), fetchIssues: vi.fn(async () => ({ imported: 0, total: null, truncated: false })),
      listTransitions: vi.fn(async () => []), applyTransition: vi.fn(),
    } as unknown as TaskboardApi;
    render(<TaskboardPage api={api} />);
    await screen.findByText("Task");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const select = await screen.findByLabelText("Move task");
    fireEvent.change(select, { target: { value: "c2" } });
    expect((screen.getByLabelText("Move task") as HTMLSelectElement).disabled).toBe(true);
    expect(moveCalls).toEqual(["c2"]);
    fireEvent.change(screen.getByLabelText("Move task"), { target: { value: "c3" } });
    expect(moveCalls).toEqual(["c2"]);
    rejectMove(new Error("failed"));
    await waitFor(() => expect((screen.getByLabelText("Move task") as HTMLSelectElement).value).toBe("c1"));
    expect(moveCalls).toEqual(["c2"]);
  });
});
