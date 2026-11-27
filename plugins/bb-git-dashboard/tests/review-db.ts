// The store's database in tests: node:sqlite behind the part of better-sqlite3 that ReviewDb names.
import { DatabaseSync } from "node:sqlite";
import { REVIEW_MIGRATIONS, type ReviewDb } from "../src/adapters/bb/review-store.ts";

export function memoryDb(): ReviewDb {
  const db = new DatabaseSync(":memory:");
  for (const migration of REVIEW_MIGRATIONS) db.exec(migration);
  let depth = 0;
  return {
    prepare: sql => {
      const statement = db.prepare(sql);
      return {
        get: (...values) => statement.get(...values as never[]),
        all: (...values) => statement.all(...values as never[]),
        run: (...values) => statement.run(...values as never[]),
      };
    },
    exec: sql => db.exec(sql),
    transaction: work => () => {
      const outer = depth === 0;
      if (outer) db.exec("BEGIN");
      depth++;
      try { const result = work(); if (outer) db.exec("COMMIT"); return result; }
      catch (error) { if (outer) db.exec("ROLLBACK"); throw error; }
      finally { depth--; }
    },
  };
}
