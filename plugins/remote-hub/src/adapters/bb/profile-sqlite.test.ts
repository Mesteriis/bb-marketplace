import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileBook } from "../../core/profile-book.ts";
import type { ProfileFields } from "../../core/profile.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { PROFILE_LATER_MIGRATIONS, PROFILE_MIGRATIONS } from "./profile-sqlite.ts";
import { createSqliteProfileStore } from "./profile-sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary database file, migrated the way bb.storage.migrate does (statement index order). */
function openDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-profiles-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db"));
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
  return db;
}

const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const FIELDS: ProfileFields = {
  name: "build",
  protocol: "ssh",
  group: "lab",
  tags: ["linux", "ci"],
  favorite: true,
  color: "#3a7d44",
  host: "build.example.test",
  port: 2222,
  username: "ci",
  domain: null,
  authType: "password",
  identityFile: null,
  credentialRef: REF,
  rdpWidth: null,
  rdpHeight: null,
};

function book(db: Database.Database) {
  let n = 0;
  return new ProfileBook({
    store: createSqliteProfileStore(db),
    now: () => new Date("2026-11-18T10:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

describe("sqlite profile store", () => {
  it("round-trips every field of an SSH and an RDP profile", () => {
    const db = openDb();
    const b = book(db);
    const ssh = b.save({ fields: FIELDS });
    const rdp = b.save({
      fields: { ...FIELDS, name: "win", protocol: "rdp", username: "admin", domain: "CORP", port: null, group: null, tags: [], favorite: false, color: null, credentialRef: null, rdpWidth: 1280, rdpHeight: 800 },
    });
    b.recordFailure(ssh.id, "not_found");
    b.recordOpen(rdp.id);
    const fresh = book(db).list();
    expect(fresh.find((p) => p.id === ssh.id)).toEqual({ ...ssh, recentErrors: [{ at: "2026-11-18T10:00:00.000Z", code: "not_found" }] });
    expect(fresh.find((p) => p.id === rdp.id)).toEqual({ ...rdp, lastOpenedAt: "2026-11-18T10:00:00.000Z" });
  });

  it("the stored row has exactly the profile columns and no secret column or value", () => {
    const db = openDb();
    book(db).save({ fields: FIELDS });
    const row = db.prepare("SELECT * FROM profiles").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        "auth_type",
        "color",
        "created_at",
        "credential_ref",
        "domain",
        "execution_host_id",
        "favorite",
        "grp",
        "host",
        "id",
        "identity_file",
        "last_opened_at",
        "name",
        "needs_config",
        "origin",
        "port",
        "protocol",
        "rdp_height",
        "rdp_options",
        "rdp_width",
        "recent_errors",
        "tags",
        "updated_at",
        "username",
      ].sort(),
    );
    expect(row.credential_ref).toBe(REF);
    for (const column of Object.keys(row)) expect(column).not.toMatch(/password|passphrase|secret|private|token|sealed/i);
  });

  it("a password smuggled into the input never reaches the database", () => {
    const db = openDb();
    expect(() => book(db).save({ fields: { ...FIELDS, password: "S3cr3t-MARK-77" } as never })).toThrow();
    expect(() => book(db).save({ fields: { ...FIELDS, credentialRef: "S3cr3t-MARK-77" } })).toThrow();
    const dump = JSON.stringify(db.prepare("SELECT * FROM profiles").all());
    expect(dump).toBe("[]");
  });

  it("delete removes the row; a row that no longer validates is skipped, not fatal", () => {
    const db = openDb();
    const b = book(db);
    const keep = b.save({ fields: { ...FIELDS, name: "keep" } });
    const gone = b.save({ fields: { ...FIELDS, name: "gone" } });
    expect(b.remove(gone.id)).toBe(true);
    db.prepare("UPDATE profiles SET host = ? WHERE id = ?").run("-bad host", keep.id);
    const other = b.save({ fields: { ...FIELDS, name: "other" } });
    expect(book(db).list().map((p) => p.id)).toEqual([other.id]);
  });
});

describe("upgrading a database made by the schema before the needs_config backfill (W4)", () => {
  it("an unresolved import link makes its profile restricted; resolved links and manual profiles are left alone; the earlier statements keep their positions", async () => {
    const { CREDENTIAL_MIGRATIONS } = await import("./credential-sqlite.ts");
    const { IMPORT_MIGRATIONS } = await import("./import-sqlite.ts");
    const { RDP_TRUST_MIGRATIONS } = await import("./rdp-trust-sqlite.ts");
    const { ALL_MIGRATIONS, NEEDS_CONFIG_BACKFILL } = await import("./migrations.ts");
    // The list as the previous release ran it (bb.storage.migrate numbers statements by position).
    const previous = [...PROFILE_MIGRATIONS, ...CREDENTIAL_MIGRATIONS, ...IMPORT_MIGRATIONS, ...PROFILE_LATER_MIGRATIONS, ...RDP_TRUST_MIGRATIONS];
    expect(ALL_MIGRATIONS.slice(0, previous.length)).toEqual(previous);
    const { AGENT_MIGRATIONS } = await import("./agent-sqlite.ts");
    const { PROFILE_RDP_OPTIONS_MIGRATIONS } = await import("./profile-sqlite.ts");
    expect(ALL_MIGRATIONS.slice(previous.length)).toEqual([...NEEDS_CONFIG_BACKFILL, ...AGENT_MIGRATIONS, ...PROFILE_RDP_OPTIONS_MIGRATIONS]);
    const db = new Database(":memory:");
    for (const statement of previous) db.exec(statement);
    const profile = (id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO profiles (id, name, protocol, grp, tags, favorite, color, host, port, username, domain, auth_type, identity_file, credential_ref, rdp_width, rdp_height, execution_host_id, origin, created_at, updated_at, last_opened_at, recent_errors)
           VALUES (?, ?, 'ssh', NULL, '[]', 0, NULL, 'h', NULL, NULL, NULL, 'agent', NULL, NULL, NULL, NULL, 'local', 'imported', 'x', 'x', NULL, '[]')`,
        )
        .run(id, name);
    profile("p-unresolved", "jump");
    profile("p-resolved", "build");
    profile("p-manual", "manual");
    const link = (profile_id: string, key: string, resolved: number) =>
      db.prepare("INSERT INTO import_links (source_id, entry_key, profile_id, imported_json, resolved, flags_json, stale) VALUES ('s', ?, ?, '{}', ?, '[]', 0)").run(key, profile_id, resolved);
    link("p-unresolved", "jump", 0);
    link("p-resolved", "build", 1);
    for (const statement of NEEDS_CONFIG_BACKFILL) db.exec(statement);
    expect(db.prepare("SELECT id, needs_config FROM profiles ORDER BY id").all()).toEqual([
      { id: "p-manual", needs_config: 0 },
      { id: "p-resolved", needs_config: 0 },
      { id: "p-unresolved", needs_config: 1 },
    ]);
    db.close();
  });
});

describe("RDP connection options in the profile store (P1)", () => {
  const RDP_FIELDS: ProfileFields = { ...FIELDS, name: "win", protocol: "rdp", username: "admin", domain: "CORP", port: null, group: null, tags: [], favorite: false, color: null, credentialRef: null, rdpWidth: 1280, rdpHeight: 800 };
  const SLOW = { compression: true, colorDepth: 16, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: false } as const;

  it("stored options come back exactly; an SSH profile has none", () => {
    const db = openDb();
    const b = book(db);
    const rdp = b.save({ fields: { ...RDP_FIELDS, rdpOptions: SLOW } });
    const ssh = b.save({ fields: FIELDS });
    expect(createSqliteProfileStore(db).get(rdp.id)?.rdpOptions).toEqual(SLOW);
    expect(createSqliteProfileStore(db).get(ssh.id)?.rdpOptions ?? null).toBeNull();
    db.close();
  });

  it("a database from before the option column: RDP profiles get the VPN/WAN default (Balanced), SSH profiles stay without", async () => {
    const { ALL_MIGRATIONS } = await import("./migrations.ts");
    const { PROFILE_RDP_OPTIONS_MIGRATIONS } = await import("./profile-sqlite.ts");
    const previous = ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.length - PROFILE_RDP_OPTIONS_MIGRATIONS.length);
    const db = new Database(":memory:");
    for (const statement of previous) db.exec(statement);
    const insert = (id: string, protocol: string) =>
      db
        .prepare(
          `INSERT INTO profiles (id, name, protocol, grp, tags, favorite, color, host, port, username, domain, auth_type, identity_file, credential_ref, rdp_width, rdp_height, execution_host_id, origin, created_at, updated_at, last_opened_at, recent_errors, needs_config)
           VALUES (?, ?, ?, NULL, '[]', 0, NULL, 'h.example.test', NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, 'local', 'manual', 'x', 'x', NULL, '[]', 0)`,
        )
        .run(id, id, protocol, protocol === "rdp" ? "admin" : null, protocol === "rdp" ? "password" : "agent");
    insert("00000000-0000-4000-8000-000000000001", "rdp");
    insert("00000000-0000-4000-8000-000000000002", "ssh");
    for (const statement of PROFILE_RDP_OPTIONS_MIGRATIONS) db.exec(statement);
    const store = createSqliteProfileStore(db);
    expect(store.get("00000000-0000-4000-8000-000000000001")?.rdpOptions).toEqual({ compression: true, colorDepth: 32, wallpaper: false, fullWindowDrag: false, menuAnimations: false, fontSmoothing: true, desktopComposition: false, themes: true });
    expect(store.get("00000000-0000-4000-8000-000000000002")?.rdpOptions ?? null).toBeNull();
    db.close();
  });

  it("a stored value outside the closed set is not read back (the profile is left out, like any invalid row)", () => {
    const db = openDb();
    const rdp = book(db).save({ fields: { ...RDP_FIELDS, rdpOptions: SLOW } });
    db.prepare("UPDATE profiles SET rdp_options = ? WHERE id = ?").run(JSON.stringify({ ...SLOW, colorDepth: 8 }), rdp.id);
    expect(createSqliteProfileStore(db).get(rdp.id)).toBeNull();
    db.close();
  });
});
