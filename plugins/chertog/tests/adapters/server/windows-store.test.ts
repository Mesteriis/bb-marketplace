import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createWindowsStore } from "../../../src/adapters/bb/server/windows-store.ts";

it("keeps a single owner across independently opened SQLite transactions", () => {
  const directory = mkdtempSync(join(tmpdir(), "chertog-windows-"));
  const file = join(directory, "placement.db");
  const db = new DatabaseSync(file);
  const concurrent = new DatabaseSync(file);
  try {
    let time = 100000;
    const a = createWindowsStore(db, () => time);
    const b = createWindowsStore(concurrent, () => time);
    const source = a("source", false).snapshot.instanceId;
    const first = b("first", false).snapshot.instanceId;
    const second = b("second", false).snapshot.instanceId;
    const key = { threadId: "thr_a" };
    // Two documents have both observed generation zero on independent connections.
    expect(a("source", false).snapshot.placements).toEqual([]);
    expect(b("second", false).snapshot.placements).toEqual([]);
    a("source", false, { ...key, generation: 0, command: { action: "claim" } });
    expect(() => b("second", false, { ...key, generation: 0, command: { action: "claim" } })).toThrow();
    expect(b("second", false).snapshot.placements[0].placement).toEqual({ owner: source, generation: 1, transfer: null });
    a("source", false, { ...key, generation: 1, command: { action: "prepare", target: first } });
    expect(() => b("source", false, { ...key, generation: 1, command: { action: "prepare", target: second } })).toThrow();
    b("first", true);
    expect(a("source", false).snapshot.placements[0].placement).toEqual({ owner: source, generation: 3, transfer: null });
    a("source", false, { ...key, generation: 3, command: { action: "prepare", target: second } });
    time += 31000;
    expect(b("source", false).snapshot.placements[0].placement).toEqual({ owner: source, generation: 5, transfer: null });
    expect(() => b("second", false, { ...key, generation: 4, command: { action: "ready" } })).toThrow();
  } finally {
    concurrent.close();
    db.close();
    rmSync(directory, { recursive: true });
  }
});
