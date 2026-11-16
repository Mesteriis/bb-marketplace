import { describe, expect, it } from "vitest";
import { createBoard, createTask, listTasks } from "./board.ts";
import { createConnection } from "./connections.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";
import { type FetchLike } from "./jira.ts";
import { fetchIssues, moveTask, type SyncDeps } from "./sync.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function issue(key: string, summary: string, statusName: string) {
  return { key, fields: { summary, status: { name: statusName, id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null } };
}

function router(handlers: { search?: () => unknown; transitions?: () => unknown; post?: () => void }): FetchLike {
  return async (url, init) => {
    const method = init.method ?? "GET";
    if (url.includes("/search")) return jsonResponse(handlers.search?.() ?? { issues: [], total: 0 });
    if (url.includes("/transitions") && method === "GET") return jsonResponse(handlers.transitions?.() ?? { transitions: [] });
    if (url.includes("/transitions") && method === "POST") {
      handlers.post?.();
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected " + url);
  };
}

function makeSync(fetchFn: FetchLike) {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock();
  const connDeps = { store, credentials, idgen, clock };
  const sync: SyncDeps = { store, credentials, idgen, clock, fetchFn };
  return { store, credentials, connDeps, sync };
}

function makeConnection(connDeps: ReturnType<typeof makeSync>["connDeps"]) {
  return createConnection(
    { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" },
    connDeps,
  );
}

describe("fetchIssues", () => {
  it("imports issues as jira-origin tasks and appends unknown status columns", async () => {
    const { store, connDeps, sync } = makeSync(router({
      search: () => ({ issues: [issue("B-1", "One", "To do"), issue("B-2", "Two", "Review")], total: 2 }),
    }));
    const connection = makeConnection(connDeps);
    const result = await fetchIssues(connection.id, sync);
    expect(result).toEqual({ imported: 2, total: null, truncated: false });
    const board = store.listBoards()[0];
    expect(board.connectionId).toBe(connection.id);
    const { tasks, columns } = listTasks(board.id, sync);
    expect(tasks.map((task) => task.originKey).sort()).toEqual(["B-1", "B-2"]);
    expect(tasks.every((task) => task.origin === "jira")).toBe(true);
    expect(columns.map((column) => column.name)).toEqual(["To do", "In progress", "Done", "Review"]);
  });

  it("updates existing tasks instead of duplicating them", async () => {
    const { store, connDeps, sync } = makeSync(router({ search: () => ({ issues: [issue("B-1", "One", "To do")], total: 1 }) }));
    const connection = makeConnection(connDeps);
    await fetchIssues(connection.id, sync);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    expect(listTasks(board.id, sync).tasks).toHaveLength(1);
  });
});

describe("moveTask", () => {
  it("moves a local task without contacting Jira", async () => {
    const { sync } = makeSync(router({}));
    const board = createBoard("Local", sync);
    const task = createTask({ boardId: board.id, title: "T" }, sync);
    const moved = await moveTask(task.id, board.columns[1].id, sync);
    expect(moved.status).toBe(board.columns[1].id);
  });

  it("applies a Jira transition then moves the local column", async () => {
    const posted: string[] = [];
    const { store, connDeps, sync } = makeSync(router({
      search: () => ({ issues: [issue("B-1", "One", "To do")], total: 1 }),
      transitions: () => ({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] }),
      post: () => posted.push("B-1"),
    }));
    const connection = makeConnection(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const { tasks, columns } = listTasks(board.id, sync);
    const jiraTask = tasks[0];
    const inProgress = columns.find((column) => column.name === "In progress");
    const moved = await moveTask(jiraTask.id, inProgress!.id, sync);
    expect(moved.status).toBe(inProgress!.id);
    expect(posted).toEqual(["B-1"]);
  });

  it("rolls back when no transition leads to the target column", async () => {
    const { store, connDeps, sync } = makeSync(router({
      search: () => ({ issues: [issue("B-1", "One", "To do")], total: 1 }),
      transitions: () => ({ transitions: [{ id: "11", name: "Start", to: { name: "Blocked" } }] }),
      post: () => { throw new Error("must not post"); },
    }));
    const connection = makeConnection(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const { tasks, columns } = listTasks(board.id, sync);
    const jiraTask = tasks[0];
    const done = columns.find((column) => column.name === "Done");
    await expect(moveTask(jiraTask.id, done!.id, sync)).rejects.toMatchObject({ kind: "conflict" });
    expect(store.getTask(jiraTask.id)?.status).toBe(jiraTask.status);
  });
});
