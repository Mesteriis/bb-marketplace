import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { embedMigration, embedResources } from "../src/adapters/bb/embed-resources.ts";
it("restores the same private reference only for the owning account and topic", () => {
  const db = new Database(":memory:");
  try {
    db.exec(embedMigration);
    const store = embedResources(db);
    const ref = store.bind("fixture-account", "21", 7);
    expect(ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(embedResources(db).bind("fixture-account", "21", 7)).toBe(ref);
    expect(store.bind("fixture-account", "21")).not.toBe(ref);
    expect(store.resolve("other-account", ref)).toBeUndefined();
    expect(store.resolve("fixture-account", ref)).toEqual({ id: "21", topicId: 7 });
  } finally { db.close(); }
});
