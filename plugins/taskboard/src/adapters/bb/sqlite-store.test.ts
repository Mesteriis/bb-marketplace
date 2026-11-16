import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqliteStore, MIGRATIONS } from "./sqlite-store.ts";

function makeStore() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return createSqliteStore(db);
}

describe("sqlite TaskStore", () => {
  it("round-trips boards, columns and tasks", () => {
    const store = makeStore();
    store.saveBoard({ id: "b1", name: "Board", connectionId: null });
    store.saveColumns("b1", [
      { id: "c1", boardId: "b1", name: "To do", order: 0 },
      { id: "c2", boardId: "b1", name: "Done", order: 1 },
    ]);
    store.saveTask({
      id: "t1", boardId: "b1", title: "One", description: "d", status: "c1", origin: "jira",
      originKey: "B-1", originUrl: "https://x/browse/B-1", labels: ["a", "b"],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0,
    });
    expect(store.listBoards().map((board) => board.id)).toEqual(["b1"]);
    expect(store.listColumns("b1").map((column) => column.name)).toEqual(["To do", "Done"]);
    const task = store.getTask("t1");
    expect(task?.originKey).toBe("B-1");
    expect(task?.labels).toEqual(["a", "b"]);
  });

  it("replaces columns and cascades board deletion", () => {
    const store = makeStore();
    store.saveBoard({ id: "b1", name: "Board", connectionId: null });
    store.saveColumns("b1", [{ id: "c1", boardId: "b1", name: "A", order: 0 }]);
    store.saveColumns("b1", [{ id: "c2", boardId: "b1", name: "B", order: 0 }]);
    expect(store.listColumns("b1").map((column) => column.name)).toEqual(["B"]);
    store.saveTask({ id: "t1", boardId: "b1", title: "One", description: "", status: "c2", origin: "local", originKey: null, originUrl: null, labels: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0 });
    store.deleteBoard("b1");
    expect(store.listBoards()).toHaveLength(0);
    expect(store.listTasks("b1")).toHaveLength(0);
  });

  it("round-trips a connection record", () => {
    const store = makeStore();
    store.saveConnection({
      id: "j1", name: "Jira", edition: "server", baseUrl: "https://jira.example.com/jira", email: null,
      projectKey: "B", jql: "project = B", hasCredential: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const connection = store.getConnection("j1");
    expect(connection?.edition).toBe("server");
    expect(connection?.baseUrl).toBe("https://jira.example.com/jira");
    expect(connection?.hasCredential).toBe(true);
  });
});
