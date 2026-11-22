import { createHash } from "node:crypto";
import {
  depart,
  placementSchema,
  PRESENCE_MS,
  reconcile,
  transition,
  type Placement,
  type Action,
} from "../../../core/windows/ownership.ts";
import type { WindowSnapshot } from "../../../core/windows/wire.ts";

interface WindowDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: (number | string)[]): unknown;
    get(...params: (number | string)[]): unknown;
    all(...params: (number | string)[]): unknown[];
  };
}

export function createWindowsStore(db: WindowDatabase, now = Date.now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chertog_window (id TEXT PRIMARY KEY, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chertog_placement (thread TEXT PRIMARY KEY, state TEXT NOT NULL);`);
  const load = db.prepare("SELECT thread, state FROM chertog_placement");
  const save = db.prepare("INSERT OR REPLACE INTO chertog_placement(thread,state) VALUES (?,?)");
  const seen = db.prepare("INSERT OR REPLACE INTO chertog_window(id,seen) VALUES (?,?)");
  const presence = db.prepare("SELECT id FROM chertog_window WHERE seen >= 0 AND seen > ?");
  const lookup = db.prepare("SELECT seen FROM chertog_window WHERE id=?");
  const transact = (credential: string, close: boolean, mutation?: { threadId: string; generation: number; command: Action }, graceful = true) => {
    const instanceId = createHash("sha256").update(credential).digest("hex");
    const time = now();
    const online = () => (presence.all(time - PRESENCE_MS) as { id: string }[]).map((row) => row.id);
    // A delayed heartbeat cannot revive a document after explicit departure.
    const old = lookup.get(instanceId) as { seen: number } | undefined;
    const joined = !old || old.seen <= time - PRESENCE_MS;
    if (old?.seen === -1 && !close) throw new Error("Окно закрыто");
    seen.run(instanceId, close ? -1 : time);
    const windows = online();
    const present = new Set(windows);
    const rows = new Map<string, Placement>();
    let changed = joined || close;
    for (const row of load.all() as { thread: string; state: string }[]) {
      const previous = placementSchema.parse(JSON.parse(row.state));
      const p = close && graceful ? depart(previous, instanceId, present, time) : reconcile(previous, present, time);
      if (p !== previous) {
        save.run(row.thread, JSON.stringify(p));
        changed = true;
      }
      rows.set(row.thread, p);
    }
    if (mutation) {
      const p = transition(rows.get(mutation.threadId) ?? null, instanceId, mutation.generation, mutation.command, present, time);
      rows.set(mutation.threadId, p);
      save.run(mutation.threadId, JSON.stringify(p));
      changed = true;
    }
    const snapshot: WindowSnapshot = {
      instanceId,
      windows,
      placements: Array.from(rows, ([threadId, placement]) => ({ threadId, placement })),
    };
    return { snapshot, changed };
  };
  return (...args: Parameters<typeof transact>) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = transact(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}
