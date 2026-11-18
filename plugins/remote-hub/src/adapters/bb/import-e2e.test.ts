// The import feature end to end over FIXTURE directories only: real files, the real FS reader, a real SQLite
// database, the real profile and credential books. Never the real ~/.ssh, /etc/ssh or /etc/hosts.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialBook } from "../../core/credential.ts";
import { ImportBook } from "../../core/import-book.ts";
import { ProfileBook } from "../../core/profile-book.ts";
import { CREDENTIAL_MIGRATIONS, createSqliteCredentialStore } from "./credential-sqlite.ts";
import { createFsSourceReader } from "./fs-source-reader.ts";
import { IMPORT_MIGRATIONS, createSqliteImportStore } from "./import-sqlite.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { createSqliteProfileStore } from "./profile-sqlite.ts";

const SENTINEL = "PRIVATE-KEY-BODY-SENTINEL-77c1";
let dir = "";
let home = "";
let db: Database.Database;
let book: ImportBook;
let profiles: ProfileBook;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-imp-e2e-"));
  home = join(dir, "home");
  mkdirSync(join(home, ".ssh", "conf.d"), { recursive: true });
  writeFileSync(
    join(home, ".ssh", "config"),
    `Include conf.d/*.conf
Host build
  HostName build.example.test
  Port 2222
  User ci
  IdentityFile ~/.ssh/id_build
Host jump
  ProxyJump bastion.example.test
Host *
  ServerAliveInterval 30
`,
  );
  writeFileSync(join(home, ".ssh", "conf.d", "web.conf"), "Host web\n  HostName web.example.test\n  User deploy\n");
  writeFileSync(join(home, ".ssh", "id_build"), `-----BEGIN OPENSSH PRIVATE KEY-----\n${SENTINEL}\n-----END OPENSSH PRIVATE KEY-----\n`);
  writeFileSync(join(home, ".ssh", "id_build.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA build@fixture\n");
  writeFileSync(join(home, "hosts"), "127.0.0.1 localhost\n10.0.0.5 files.example.test\n");
  db = new Database(":memory:");
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  profiles = new ProfileBook({ store: createSqliteProfileStore(db), now: () => new Date("2026-11-18T10:00:00.000Z"), newId: ids });
  const vault = { save: async () => {}, delete: async () => {}, status: async () => "present" as const };
  let imports!: ImportBook;
  const credentials = new CredentialBook({ store: createSqliteCredentialStore(db), vault, profiles, now: () => new Date(), newId: ids });
  imports = new ImportBook({ store: createSqliteImportStore(db), reader: createFsSourceReader({ home, env: {} }), profiles, credentials, newId: ids });
  book = imports;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const applyReviewed = async (id: string) => {
  const scan = await book.scan(id);
  if (scan.kind !== "ssh-config" && scan.kind !== "hosts") throw new Error("kind");
  return book.apply(id, undefined, scan.scanId);
};

const enable = (kind: "ssh-config" | "keys-dir" | "hosts", path: string) => {
  const s = book.addSource({ kind, path, label: kind });
  book.setEnabled(s.id, true);
  return s;
};

describe("import over fixture directories", () => {
  it("imports aliases from the config and its Include, resolves what it can, keeps the rest on the user's config", async () => {
    const source = enable("ssh-config", join(home, ".ssh", "config"));
    expect(await applyReviewed(source.id)).toMatchObject({ created: 3 });
    const by = (name: string) => profiles.list().find((p) => p.name === name)!;
    expect(by("build")).toMatchObject({ host: "build.example.test", port: 2222, username: "ci", authType: "key", identityFile: join(home, ".ssh", "id_build"), origin: "imported" });
    expect(by("web")).toMatchObject({ host: "web.example.test", username: "deploy", authType: "agent" });
    expect(by("jump")).toMatchObject({ host: "jump", port: null, username: null });
    const decorated = book.decorate(profiles.list());
    expect(decorated.find((p) => p.name === "jump")?.provenance).toMatchObject({ resolved: false, flags: ["proxy"] });
    expect(decorated.find((p) => p.name === "build")?.provenance).toMatchObject({ resolved: true, stale: false, editedLocally: false });
  });

  it("importing twice writes nothing the second time (profile and link rows are byte-identical)", async () => {
    const source = enable("ssh-config", join(home, ".ssh", "config"));
    await applyReviewed(source.id);
    const dump = () => JSON.stringify([db.prepare("SELECT * FROM profiles ORDER BY id").all(), db.prepare("SELECT * FROM import_links ORDER BY entry_key").all()]);
    const before = dump();
    expect(await applyReviewed(source.id)).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(dump()).toBe(before);
  });

  it("an Include that points outside the config's directory is not followed", async () => {
    const outside = join(dir, "elsewhere.conf");
    writeFileSync(outside, "Host leaked\n  HostName leaked.example.test\n");
    symlinkSync(outside, join(home, ".ssh", "conf.d", "evil.conf"));
    writeFileSync(join(home, ".ssh", "config"), `Include conf.d/*.conf\nInclude ${outside}\nHost one\n`);
    const source = enable("ssh-config", join(home, ".ssh", "config"));
    const scan = await book.scan(source.id);
    if (scan.kind !== "ssh-config") throw new Error("kind");
    expect(scan.items.map((i) => i.key)).toEqual(["web", "one"]);
  });

  it("the keys directory yields public metadata only: no private byte reaches a result, a row or an error", async () => {
    const source = enable("keys-dir", join(home, ".ssh"));
    const scan = await book.scan(source.id);
    if (scan.kind !== "keys-dir") throw new Error("kind");
    expect(scan.keys).toEqual([expect.objectContaining({ publicPath: join(home, ".ssh", "id_build.pub"), privatePath: join(home, ".ssh", "id_build"), type: "ssh-ed25519", comment: "build@fixture" })]);
    const everything = JSON.stringify(scan) + JSON.stringify(db.prepare("SELECT * FROM import_sources").all()) + JSON.stringify(book.sources());
    expect(everything).not.toContain(SENTINEL);
    // The sentinel sits in the private file only: confirm the fixture really holds it.
    expect(readFileSync(join(home, ".ssh", "id_build"), "utf8")).toContain(SENTINEL);
    const allRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    for (const { name } of allRows) expect(JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).not.toContain(SENTINEL);
  });

  it("a hosts file offers names, not loopback entries", async () => {
    const source = enable("hosts", join(home, "hosts"));
    const scan = await book.scan(source.id);
    if (scan.kind !== "hosts") throw new Error("kind");
    expect(scan.items.map((i) => i.key)).toEqual(["files.example.test"]);
  });

  it("a source that vanished is reported as unreadable, not as empty", async () => {
    const source = enable("hosts", join(home, "missing-hosts"));
    await expect(book.scan(source.id)).rejects.toMatchObject({ code: "source_unreadable" });
  });
});
