import { describe, expect, it } from "vitest";
import { createBoard, createTask, deleteBoard, listBoards, listTasks, moveLocalTask, updateBoard, updateTask } from "./board.ts";
import type { BoardDeps } from "./board.ts";
import { DomainError } from "./errors.ts";
import { createFakeClock, createFakeId, createFakeStore } from "./testing/fakes.ts";

function deps(): BoardDeps {
  return { store: createFakeStore(), idgen: createFakeId(), clock: createFakeClock() };
}

describe("boards", () => {
  it("creates a board with three default columns in order", () => {
    const board = createBoard("My board", deps());
    expect(board.columns.map((column) => column.name)).toEqual(["To do", "In progress", "Done"]);
    expect(board.connectionId).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(() => createBoard("   ", deps())).toThrowError(/Name is required/);
  });

  it("renames, reorders and re-homes tasks when a column is removed", () => {
    const d = deps();
    const board = createBoard("B", d);
    const todo = board.columns[0].id;
    const done = board.columns[2].id;
    const task = createTask({ boardId: board.id, title: "One", status: done }, d);
    const updated = updateBoard({ boardId: board.id, name: "Renamed", columns: [{ id: todo, name: "Backlog", order: 0 }] }, d);
    expect(updated.name).toBe("Renamed");
    expect(updated.columns).toHaveLength(1);
    expect(listTasks(board.id, d).tasks.find((entry) => entry.id === task.id)?.status).toBe(todo);
  });

  it("rejects duplicate column names", () => {
    const d = deps();
    const board = createBoard("B", d);
    expect(() =>
      updateBoard({ boardId: board.id, name: "B", columns: [{ name: "A", order: 0 }, { name: "a", order: 1 }] }, d),
    ).toThrowError(/unique/);
  });
});

describe("tasks", () => {
  it("creates a local task in the first column by default", () => {
    const d = deps();
    const board = createBoard("B", d);
    const task = createTask({ boardId: board.id, title: "Hello", description: "d" }, d);
    expect(task.origin).toBe("local");
    expect(task.originKey).toBeNull();
    expect(task.status).toBe(board.columns[0].id);
    expect(task.description).toBe("d");
  });

  it("rejects an unknown status column", () => {
    const d = deps();
    const board = createBoard("B", d);
    expect(() => createTask({ boardId: board.id, title: "x", status: "missing" }, d)).toThrowError(/Unknown status/);
  });

  it("rejects an empty title", () => {
    const d = deps();
    const board = createBoard("B", d);
    expect(() => createTask({ boardId: board.id, title: "  " }, d)).toThrowError(/Title is required/);
  });

  it("updates title and description", () => {
    const d = deps();
    const board = createBoard("B", d);
    const task = createTask({ boardId: board.id, title: "Old" }, d);
    const updated = updateTask({ taskId: task.id, title: "New", description: "Body" }, d);
    expect(updated.title).toBe("New");
    expect(updated.description).toBe("Body");
  });

  it("rejects an empty title on update", () => {
    const d = deps();
    const board = createBoard("B", d);
    const task = createTask({ boardId: board.id, title: "Old" }, d);
    expect(() => updateTask({ taskId: task.id, title: " " }, d)).toThrowError(/Title is required/);
  });

  it("moves a local task between columns", () => {
    const d = deps();
    const board = createBoard("B", d);
    const task = createTask({ boardId: board.id, title: "One" }, d);
    const moved = moveLocalTask(task.id, board.columns[1].id, d);
    expect(moved.status).toBe(board.columns[1].id);
  });
});

describe("deletion", () => {
  it("deletes a board with its tasks", () => {
    const d = deps();
    const board = createBoard("B", d);
    createTask({ boardId: board.id, title: "One" }, d);
    deleteBoard(board.id, d);
    expect(listBoards(d)).toHaveLength(0);
    expect(listTasks(board.id, d).tasks).toHaveLength(0);
  });
});
