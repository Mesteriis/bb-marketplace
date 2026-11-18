import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_MIGRATIONS } from "./credential-sqlite.ts";
import { IMPORT_MIGRATIONS, createSqliteImportStore } from "./import-sqlite.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function openDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-imp-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db"));
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
  return db;
}

describe("sqlite import store", () => {
  it("round-trips sources and links, in insertion order, and updates in place", () => {
    const store = createSqliteImportStore(openDb());
    store.putSource({ id: "s1", kind: "ssh-config", path: "/f/config", label: "cfg", enabled: false, useSshG: false });
    store.putSource({ id: "s2", kind: "agent", path: null, label: "agent", enabled: true, useSshG: false });
    store.putSource({ id: "s1", kind: "ssh-config", path: "/f/config", label: "cfg", enabled: true, useSshG: true });
    expect(store.sources()).toEqual([
      { id: "s1", kind: "ssh-config", path: "/f/config", label: "cfg", enabled: true, useSshG: true },
      { id: "s2", kind: "agent", path: null, label: "agent", enabled: true, useSshG: false },
    ]);
    const link = { profileId: "p1", sourceId: "s1", key: "build", imported: { host: "h", port: 22, username: null, authType: "agent" as const, identityFile: null }, resolved: false, flags: ["proxy"], stale: false };
    store.putLink(link);
    store.putLink({ ...link, stale: true });
    expect(store.links("s1")).toEqual([{ ...link, stale: true }]);
    expect(store.links("s2")).toEqual([]);
    expect(store.links()).toHaveLength(1);
    store.removeLinksOfSource("s1");
    expect(store.links()).toEqual([]);
    expect(store.removeSource("s1")).toBe(true);
    expect(store.removeSource("s1")).toBe(false);
  });

  it("a row this version cannot read is skipped, not thrown", () => {
    const db = openDb();
    db.prepare("INSERT INTO import_sources VALUES ('x','future-kind','/p','l',1,0)").run();
    db.prepare("INSERT INTO import_links VALUES ('s','k','p','not json','1','[]',0)").run();
    const store = createSqliteImportStore(db);
    expect(store.sources()).toEqual([]);
    expect(store.links()).toEqual([]);
  });
});
