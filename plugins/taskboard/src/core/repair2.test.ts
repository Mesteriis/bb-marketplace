import { describe, expect, it } from "vitest";
import { listBoards, listTasks, updateBoard } from "./board.ts";
import { createConnection } from "./connections.ts";
import { rpcSchemas } from "./contract.ts";
import { createJiraClient, type FetchLike } from "./jira.ts";
import { applyTransition, fetchIssues } from "./sync.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeDeps(fetchFn: FetchLike) {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock();
  const connDeps = { store, credentials, idgen, clock };
  return { store, credentials, connDeps, sync: { store, credentials, idgen, clock, fetchFn } };
}

function cloudConnection(connDeps: ReturnType<typeof makeDeps>["connDeps"]) {
  return createConnection(
    { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" },
    connDeps,
  );
}

function oneIssue() {
  return { key: "B-1", fields: { summary: "One", status: { name: "To do", id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null, description: "" } };
}

describe("column-capacity preflight", () => {
  it("refuses a transition to a new column at the cap without any POST", async () => {
    const posts: string[] = [];
    const { connDeps, store, sync } = makeDeps(async (url, init) => {
      const method = init.method ?? "GET";
      if (url.includes("/transitions") && method === "GET") {
        return json({ transitions: [{ id: "11", name: "Start", to: { name: "Brand new" } }] });
      }
      if (url.includes("/transitions") && method === "POST") {
        posts.push("B-1");
        return new Response(null, { status: 204 });
      }
      if (url.includes("/search")) return json({ issues: [oneIssue()], nextPageToken: null });
      throw new Error("unexpected " + url);
    });
    const connection = cloudConnection(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    store.saveColumns(board.id, Array.from({ length: 50 }, (_, i) => ({ id: "c" + i, boardId: board.id, name: "Column " + i, order: i })));
    const task = store.listTasks(board.id)[0];
    store.saveTask({ ...task, status: "c0" });

    await expect(applyTransition(connection.id, "B-1", "11", sync)).rejects.toMatchObject({ kind: "conflict" });
    expect(posts).toEqual([]);
    expect(store.listColumns(board.id)).toHaveLength(50);
    expect(rpcSchemas.boards_list.output.safeParse({ boards: listBoards(sync) }).success).toBe(true);
  });
});

describe("malformed remote issues", () => {
  it("skips a blank issue and keeps the board parseable", async () => {
    const { connDeps, store, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) {
        return json({ issues: [{}, { key: "B-2", fields: { summary: "Valid", status: { name: "To do", id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null, description: "" } }], nextPageToken: null });
      }
      throw new Error("unexpected " + url);
    });
    const connection = cloudConnection(connDeps);
    const result = await fetchIssues(connection.id, sync);
    expect(result.imported).toBe(1);
    const board = store.listBoards()[0];
    const view = listTasks(board.id, sync);
    expect(view.tasks.map((task) => task.originKey)).toEqual(["B-2"]);
    expect(rpcSchemas.tasks_list.output.safeParse(view).success).toBe(true);
  });
});

describe("long base URLs", () => {
  it("sets a null originUrl instead of truncating, and output still parses", async () => {
    const longBase = "https://" + "h".repeat(1980) + ".com";
    const { connDeps, store, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) return json({ issues: [oneIssue()], total: 1 });
      throw new Error("unexpected " + url);
    });
    const connection = createConnection({ name: "S", edition: "server", baseUrl: longBase, projectKey: "B", jql: "", credential: "pat" }, connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const view = listTasks(board.id, sync);
    expect(view.tasks[0].originUrl).toBeNull();
    expect(rpcSchemas.tasks_list.output.safeParse(view).success).toBe(true);
  });
});

describe("remote-board column immutability", () => {
  it("rejects rename and removal on a Jira board but allows reorder", async () => {
    const { connDeps, store, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) return json({ issues: [oneIssue()], nextPageToken: null });
      throw new Error("unexpected " + url);
    });
    const connection = cloudConnection(connDeps);
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const cols = store.listColumns(board.id);

    expect(() =>
      updateBoard({ boardId: board.id, name: "J", columns: [{ id: cols[0].id, name: "Renamed", order: 0 }, { id: cols[1].id, name: cols[1].name, order: 1 }, { id: cols[2].id, name: cols[2].name, order: 2 }] }, sync),
    ).toThrowError(/managed by Jira/);

    expect(() =>
      updateBoard({ boardId: board.id, name: "J", columns: cols.slice(0, 2).map((column, i) => ({ id: column.id, name: column.name, order: i })) }, sync),
    ).toThrowError(/added or removed/);

    const reordered = updateBoard({ boardId: board.id, name: "J2", columns: [cols[2], cols[0], cols[1]].map((column, i) => ({ id: column.id, name: column.name, order: i })) }, sync);
    expect(reordered.name).toBe("J2");
    expect(reordered.columns.map((column) => column.id)).toEqual([cols[2].id, cols[0].id, cols[1].id]);
  });
});
