import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.ts";
import type { FetchLike } from "./jira.ts";
import { applyTransition, fetchIssues } from "./sync.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function issue(key: string, summary: string, statusName: string) {
  return { key, fields: { summary, status: { name: statusName, id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null, description: "" } };
}

function makeDeps(fetchFn: FetchLike) {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock();
  const connDeps = { store, credentials, idgen, clock };
  return { store, connDeps, sync: { store, credentials, idgen, clock, fetchFn } };
}

function cloud(connDeps: ReturnType<typeof makeDeps>["connDeps"]) {
  return createConnection({ name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" }, connDeps);
}

describe("board-scoped coordination", () => {
  it("serializes cross-issue transitions and forbids a second POST at the cap", async () => {
    const posts: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      if (url.includes("/transitions") && method === "GET") {
        const key = url.includes("B-1") ? "B-1" : "B-2";
        return json({ transitions: [{ id: "11", name: "Start", to: { name: key === "B-1" ? "New A" : "New B" } }] });
      }
      if (url.includes("/transitions") && method === "POST") { posts.push(url); return new Response(null, { status: 204 }); }
      if (url.includes("/search")) return json({ issues: [issue("B-1", "One", "To do"), issue("B-2", "Two", "To do")], nextPageToken: null });
      throw new Error("unexpected " + url);
    };
    const { connDeps, store, sync } = makeDeps(fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    store.saveColumns(board.id, Array.from({ length: 49 }, (_, i) => ({ id: "c" + i, boardId: board.id, name: "Column " + i, order: i })));
    for (const task of store.listTasks(board.id)) store.saveTask({ ...task, status: "c0" });

    const results = await Promise.allSettled([
      applyTransition(connection.id, "B-1", "11", sync),
      applyTransition(connection.id, "B-2", "11", sync),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(store.listColumns(board.id)).toHaveLength(50);
  });

  it("serializes same-issue transitions in submission order", async () => {
    const posts: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      if (url.includes("/transitions") && method === "GET") {
        return json({ transitions: [
          { id: "11", name: "Start", to: { name: "In progress" } },
          { id: "21", name: "Complete", to: { name: "Done" } },
        ] });
      }
      if (url.includes("/transitions") && method === "POST") {
        const body = JSON.parse(String(init.body)) as { transition: { id: string } };
        posts.push(body.transition.id);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/search")) return json({ issues: [issue("B-1", "One", "To do")], nextPageToken: null });
      throw new Error("unexpected " + url);
    };
    const { connDeps, store, sync } = makeDeps(fetchFn);
    const connection = cloud(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const results = await Promise.allSettled([
      applyTransition(connection.id, "B-1", "11", sync),
      applyTransition(connection.id, "B-1", "21", sync),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(posts).toEqual(["11", "21"]);
    const done = store.listColumns(board.id).find((column) => column.name === "Done");
    expect(store.listTasks(board.id)[0].status).toBe(done!.id);
  });
});

describe("malformed issue", () => {
  it("rejects a blank {} issue before any column creation", async () => {
    const { connDeps, store, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) return json({ issues: [{}], nextPageToken: null });
      throw new Error("unexpected " + url);
    });
    const connection = cloud(connDeps);
    const result = await fetchIssues(connection.id, sync);
    expect(result.imported).toBe(0);
    const board = store.listBoards()[0];
    expect(store.listColumns(board.id).map((column) => column.name)).toEqual(["To do", "In progress", "Done"]);
    expect(store.listTasks(board.id)).toHaveLength(0);
  });
});
