import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { deleteBoard, deleteTask, listBoards, listTasks } from "../../core/board.ts";
import { createConnection, deleteConnection } from "../../core/connections.ts";
import { rpcSchemas } from "../../core/contract.ts";
import type { FetchLike } from "../../core/jira.ts";
import { applyTransition, fetchIssues, moveTask } from "../../core/sync.ts";
import { createFakeClock, createFakeCredentials, createFakeId } from "../../core/testing/fakes.ts";
import { createSqliteStore, MIGRATIONS } from "./sqlite-store.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function issue(key: string, summary: string, statusName: string) {
  return { key, fields: { summary, status: { name: statusName, id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null, description: "" } };
}

function makeDeps(fetchFn: FetchLike) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const store = createSqliteStore(db);
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock();
  return {
    store,
    boardDeps: { store, idgen, clock },
    connDeps: { store, credentials, idgen, clock },
    sync: { store, credentials, idgen, clock, fetchFn },
  };
}

function cloud(connDeps: ReturnType<typeof makeDeps>["connDeps"]) {
  return createConnection({ name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" }, connDeps);
}

function heldGetFetch(): { fetchFn: FetchLike; posts: string[]; requested: () => boolean; release: (body: unknown) => void } {
  const posts: string[] = [];
  let requestedFlag = false;
  let release: (r: Response) => void = () => {};
  const gate = new Promise<Response>((resolve) => { release = resolve; });
  const fetchFn: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    if (url.includes("/search")) return json({ issues: [issue("B-1", "One", "To do")], nextPageToken: null });
    if (url.includes("/transitions") && method === "GET") { requestedFlag = true; return gate; }
    if (url.includes("/transitions") && method === "POST") { posts.push(url); return new Response(null, { status: 204 }); }
    throw new Error("unexpected " + url);
  };
  return { fetchFn, posts, requested: () => requestedFlag, release: (body) => release(json(body)) };
}

describe("held transitions GET interrupted by lifecycle deletes (real SQLite)", () => {
  it("applyTransition sends no POST when the connection is deleted during the GET", async () => {
    const held = heldGetFetch();
    const { connDeps, sync } = makeDeps(held.fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const pending = applyTransition(connection.id, "B-1", "11", sync);
    await vi.waitFor(() => expect(held.requested()).toBe(true));
    deleteConnection(connection.id, connDeps);
    held.release({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] });
    await expect(pending).rejects.toMatchObject({ kind: "not_found" });
    expect(held.posts).toHaveLength(0);
  });

  it("moveTask sends no POST when the connection is deleted during the GET", async () => {
    const held = heldGetFetch();
    const { store, connDeps, sync } = makeDeps(held.fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const task = store.listTasks(board.id)[0];
    const inProgress = store.listColumns(board.id).find((column) => column.name === "In progress")!;
    const pending = moveTask(task.id, inProgress.id, sync);
    await vi.waitFor(() => expect(held.requested()).toBe(true));
    deleteConnection(connection.id, connDeps);
    held.release({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] });
    await expect(pending).rejects.toMatchObject({ kind: "not_found" });
    expect(held.posts).toHaveLength(0);
  });

  it("moveTask sends no POST when the board is deleted during the GET", async () => {
    const held = heldGetFetch();
    const { store, boardDeps, connDeps, sync } = makeDeps(held.fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const task = store.listTasks(board.id)[0];
    const inProgress = store.listColumns(board.id).find((column) => column.name === "In progress")!;
    const pending = moveTask(task.id, inProgress.id, sync);
    await vi.waitFor(() => expect(held.requested()).toBe(true));
    deleteBoard(board.id, boardDeps);
    held.release({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] });
    await expect(pending).rejects.toMatchObject({ kind: "not_found" });
    expect(held.posts).toHaveLength(0);
  });

  it("moveTask sends no POST when the task is deleted during the GET", async () => {
    const held = heldGetFetch();
    const { store, boardDeps, connDeps, sync } = makeDeps(held.fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const task = store.listTasks(board.id)[0];
    const inProgress = store.listColumns(board.id).find((column) => column.name === "In progress")!;
    const pending = moveTask(task.id, inProgress.id, sync);
    await vi.waitFor(() => expect(held.requested()).toBe(true));
    deleteTask(task.id, boardDeps);
    held.release({ transitions: [{ id: "11", name: "Start", to: { name: "In progress" } }] });
    await expect(pending).rejects.toMatchObject({ kind: "not_found" });
    expect(held.posts).toHaveLength(0);
  });
});

describe("held fetch coordinates with a transition (real SQLite)", () => {
  it("the transition POST waits for the fetch and both new columns are retained", async () => {
    let searchCalls = 0;
    let releaseSecond: (r: Response) => void = () => {};
    const secondGate = new Promise<Response>((resolve) => { releaseSecond = resolve; });
    const posts: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      if (url.includes("/search")) {
        searchCalls += 1;
        if (searchCalls === 1) return json({ issues: [issue("B-1", "One", "To do")], nextPageToken: null });
        return secondGate;
      }
      if (url.includes("/transitions") && method === "GET") {
        return json({ transitions: [{ id: "11", name: "Block", to: { name: "Blocked" } }] });
      }
      if (url.includes("/transitions") && method === "POST") { posts.push(url); return new Response(null, { status: 204 }); }
      throw new Error("unexpected " + url);
    };
    const { store, connDeps, sync } = makeDeps(fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];

    const pendingFetch = fetchIssues(connection.id, sync);
    await vi.waitFor(() => expect(searchCalls).toBe(2));
    const pendingTransition = applyTransition(connection.id, "B-1", "11", sync);
    // Yield queued microtasks: without the board lock the transition would
    // already have POSTed by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toHaveLength(0);

    releaseSecond(json({ issues: [issue("B-2", "Two", "Review")], nextPageToken: null }));
    await pendingFetch;
    await pendingTransition;

    expect(posts).toHaveLength(1);
    const columns = store.listColumns(board.id);
    const names = columns.map((column) => column.name);
    expect(names).toContain("Review");
    expect(names).toContain("Blocked");
    const ids = new Set(columns.map((column) => column.id));
    for (const task of store.listTasks(board.id)) expect(ids.has(task.status)).toBe(true);
    expect(rpcSchemas.boards_list.output.safeParse({ boards: listBoards(sync) }).success).toBe(true);
    expect(rpcSchemas.tasks_list.output.safeParse(listTasks(board.id, sync)).success).toBe(true);
  });
});
