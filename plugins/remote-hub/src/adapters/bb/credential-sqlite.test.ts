import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialMeta } from "../../core/credential.ts";
import { CREDENTIAL_MIGRATIONS, createSqliteCredentialStore } from "./credential-sqlite.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary database migrated in bb.storage.migrate's order: profiles first, then credentials. */
function openDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "rh-cred-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db"));
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
  return db;
}

const ENDPOINT: CredentialMeta = {
  ref: "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a",
  kind: "password",
  label: "win",
  bind: { type: "endpoint", protocol: "rdp", host: "win.example.test", port: 3389, user: "admin", domain: "CORP" },
  executionHostId: "local",
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
};
const KEY: CredentialMeta = {
  ...ENDPOINT,
  ref: "rh-cred:v1:local:11111111-2222-4333-8444-555555555555",
  kind: "passphrase",
  label: "key",
  bind: { type: "key", path: "/Users/dev/.ssh/id_ed25519" },
};

describe("sqlite credential metadata store", () => {
  it("round-trips an endpoint-bound and a key-bound credential", () => {
    const store = createSqliteCredentialStore(openDb());
    store.put(ENDPOINT);
    store.put(KEY);
    expect(store.get(ENDPOINT.ref)).toEqual(ENDPOINT);
    expect(store.get(KEY.ref)).toEqual(KEY);
    expect(store.all().map((m) => m.ref).sort()).toEqual([ENDPOINT.ref, KEY.ref].sort());
    store.put({ ...ENDPOINT, label: "renamed" });
    expect(store.get(ENDPOINT.ref)?.label).toBe("renamed");
    expect(store.remove(ENDPOINT.ref)).toBe(true);
    expect(store.remove(ENDPOINT.ref)).toBe(false);
    expect(store.get(ENDPOINT.ref)).toBeNull();
  });

  it("the table has metadata columns only: no secret column, no secret value", () => {
    const db = openDb();
    createSqliteCredentialStore(db).put(ENDPOINT);
    const row = db.prepare("SELECT * FROM credentials").get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["bind_domain", "bind_host", "bind_path", "bind_port", "bind_protocol", "bind_type", "bind_user", "created_at", "execution_host_id", "kind", "label", "ref", "updated_at"].sort(),
    );
    for (const column of Object.keys(row)) expect(column).not.toMatch(/password|passphrase_value|secret|private|token|sealed/i);
  });

  it("a row that no longer validates is skipped, not fatal", () => {
    const db = openDb();
    const store = createSqliteCredentialStore(db);
    store.put(ENDPOINT);
    store.put(KEY);
    db.prepare("UPDATE credentials SET kind = 'nonsense' WHERE ref = ?").run(KEY.ref);
    expect(store.all().map((m) => m.ref)).toEqual([ENDPOINT.ref]);
  });
});
