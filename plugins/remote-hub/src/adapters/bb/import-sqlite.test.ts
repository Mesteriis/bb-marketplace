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

describe("a known-hosts source through the real SQLite store (W7)", () => {
  it("add -> enable -> scan -> apply works; the source is read back with its kind", async () => {
    const { ImportBook } = await import("../../core/import-book.ts");
    const { ProfileBook } = await import("../../core/profile-book.ts");
    const { CredentialBook } = await import("../../core/credential.ts");
    const { emptyReader } = await import("./import-test-support.ts");
    const KH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const db = openDb();
    let n = 0;
    const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const { createSqliteProfileStore } = await import("./profile-sqlite.ts");
    const profiles = new ProfileBook({ store: createSqliteProfileStore(db), now: () => new Date(), newId: ids });
    const credentials = new CredentialBook({ store: { all: () => [], get: () => null, put() {}, remove: () => false }, vault: { save: async () => {}, delete: async () => {}, status: async () => "missing" as const }, profiles, now: () => new Date(), newId: ids });
    const overlay: string[] = [];
    const book = new ImportBook({
      store: createSqliteImportStore(db),
      reader: { ...emptyReader, readText: (p: string) => (p === "/fixture/known_hosts" ? { text: `a.example.test ${KH}\n`, truncated: false } : null) },
      profiles,
      credentials,
      newId: () => "src-" + ++n,
      knownHosts: { list: async () => [...overlay], add: async (lines: string[]) => (overlay.push(...lines), lines.length), remove: async () => 0 },
    });
    const added = book.addSource({ kind: "known-hosts", path: "/fixture/known_hosts", label: "kh" });
    // A fresh store (a restart) still finds it, with its kind.
    const reread = new ImportBook({ store: createSqliteImportStore(db), reader: emptyReader, profiles, credentials, newId: ids });
    expect(reread.sources().map((s) => [s.id, s.kind])).toEqual([[added.id, "known-hosts"]]);
    book.setEnabled(added.id, true);
    const scan = await book.scan(added.id);
    if (scan.kind !== "known-hosts") throw new Error("kind");
    expect(scan.items.map((i) => i.hosts)).toEqual([["a.example.test"]]);
    expect(await book.apply(added.id, [scan.items[0]!.key], scan.scanId)).toMatchObject({ created: 1 });
    expect(overlay).toEqual([`a.example.test ${KH}`]);
    db.close();
  });
});
