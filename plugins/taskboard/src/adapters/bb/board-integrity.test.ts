import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBoard, updateBoard } from "../../core/board.ts";
import { createFakeClock, createFakeId } from "../../core/testing/fakes.ts";
import { createSqliteStore, MIGRATIONS } from "./sqlite-store.ts";

function deps() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return { store: createSqliteStore(db), idgen: createFakeId(), clock: createFakeClock() };
}

describe("updateBoard column integrity", () => {
  it("rejects a foreign column id without corrupting either board", () => {
    const d = deps();
    const a = createBoard("A", d);
    const b = createBoard("B", d);
    const aColumnsBefore = d.store.listColumns(a.id).map((column) => column.id).sort();
    const bColumnsBefore = d.store.listColumns(b.id).map((column) => column.id).sort();

    expect(() =>
      updateBoard({ boardId: a.id, name: "A", columns: [{ id: b.columns[0].id, name: "Stolen", order: 0 }] }, d),
    ).toThrowError(/does not belong to this board/);

    expect(d.store.listColumns(a.id).map((column) => column.id).sort()).toEqual(aColumnsBefore);
    expect(d.store.listColumns(b.id).map((column) => column.id).sort()).toEqual(bColumnsBefore);
    // Board B still owns its column row.
    expect(d.store.listColumns(b.id).some((column) => column.id === b.columns[0].id)).toBe(true);
  });

  it("rejects duplicate column ids and leaves the board unchanged", () => {
    const d = deps();
    const a = createBoard("A", d);
    const before = d.store.listColumns(a.id).map((column) => column.name);
    expect(() =>
      updateBoard(
        {
          boardId: a.id,
          name: "A",
          columns: [
            { id: a.columns[0].id, name: "X", order: 0 },
            { id: a.columns[0].id, name: "Y", order: 1 },
          ],
        },
        d,
      ),
    ).toThrowError(/unique ids/);
    expect(d.store.listColumns(a.id).map((column) => column.name)).toEqual(before);
  });
});
