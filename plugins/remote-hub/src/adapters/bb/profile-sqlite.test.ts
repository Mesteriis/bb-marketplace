import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileBook } from "../../core/profile-book.ts";
import type { ProfileFields } from "../../core/profile.ts";
import { PROFILE_MIGRATIONS, createSqliteProfileStore } from "./profile-sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary database file, migrated the way bb.storage.migrate does (statement index order). */
function openDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-profiles-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db"));
  for (const statement of PROFILE_MIGRATIONS) db.exec(statement);
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
        "origin",
        "port",
        "protocol",
        "rdp_height",
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
