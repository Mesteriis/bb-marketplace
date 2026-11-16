import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { deleteBoard } from "../../core/board.ts";
import { createConnection, deleteConnection } from "../../core/connections.ts";
import type { FetchLike } from "../../core/jira.ts";
import { fetchIssues } from "../../core/sync.ts";
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

describe("fetch interrupted by lifecycle deletes (real SQLite)", () => {
  it("board deletion during a held fetch leaves no orphan rows", async () => {
    let resolveSearch: (r: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => { resolveSearch = resolve; });
    const { store, boardDeps, connDeps, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) return gate;
      throw new Error("unexpected " + url);
    });
    const connection = cloud(connDeps);
    const pending = fetchIssues(connection.id, sync);
    await vi.waitFor(() => expect(store.listBoards()).toHaveLength(1));
    const board = store.listBoards()[0];
    deleteBoard(board.id, boardDeps);
    resolveSearch(json({ issues: [issue("B-1", "One", "To do")], nextPageToken: null }));
    const result = await pending;
    expect(result.imported).toBe(0);
    expect(store.getBoard(board.id)).toBeNull();
    expect(store.listColumns(board.id)).toHaveLength(0);
    expect(store.listTasks(board.id)).toHaveLength(0);
  });

  it("connection deletion during a held fetch preserves the cached board and imports nothing", async () => {
    let resolveSearch: (r: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => { resolveSearch = resolve; });
    const { store, connDeps, sync } = makeDeps(async (url) => {
      if (url.includes("/search")) return gate;
      throw new Error("unexpected " + url);
    });
    const connection = cloud(connDeps);
    const pending = fetchIssues(connection.id, sync);
    await vi.waitFor(() => expect(store.listBoards()).toHaveLength(1));
    const board = store.listBoards()[0];
    deleteConnection(connection.id, connDeps);
    resolveSearch(json({ issues: [issue("B-1", "One", "To do")], nextPageToken: null }));
    const result = await pending;
    expect(result.imported).toBe(0);
    expect(store.getBoard(board.id)).not.toBeNull();
    expect(store.listColumns(board.id).map((column) => column.name)).toEqual(["To do", "In progress", "Done"]);
    expect(store.listTasks(board.id)).toHaveLength(0);
  });
});
