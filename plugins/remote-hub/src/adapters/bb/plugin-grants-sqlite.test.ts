import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginGrantBook } from "../../core/plugin-grants.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { createSqlitePluginGrantStore } from "./plugin-grants-sqlite.ts";

const PROFILE = "11111111-1111-4111-8111-111111111111";
let db: Database.Database;
let n = 0;
const book = () =>
  new PluginGrantBook({ store: createSqlitePluginGrantStore(db), now: () => new Date("2026-11-27T10:00:00.000Z"), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, profileExists: () => true });
beforeEach(() => {
  db = new Database(":memory:");
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
  n = 0;
});
afterEach(() => db.close());

describe("sqlite plugin grants", () => {
  it("a request, a grant and a revoke survive a restart exactly as they were", () => {
    const first = book();
    const asked = first.request("makosh-commander", PROFILE, "write", "copy a build");
    expect(book().pending()).toEqual([{ requestId: asked.requestId, pluginId: "makosh-commander", profileId: PROFILE, level: "write", reason: "copy a build", requestedAt: "2026-11-27T10:00:00.000Z" }]);
    expect(book().check("makosh-commander", PROFILE, "read")).toEqual({ ok: false, code: "consent_required" });
    book().grant("makosh-commander", PROFILE, "read");
    expect(book().check("makosh-commander", PROFILE, "read")).toEqual({ ok: true, level: "read" });
    expect(book().check("makosh-commander", PROFILE, "write")).toEqual({ ok: false, code: "consent_required" });
    expect(book().check("another-plugin", PROFILE, "read")).toEqual({ ok: false, code: "consent_required" });
    expect(book().granted()).toEqual([{ pluginId: "makosh-commander", profileId: PROFILE, level: "read", grantedAt: "2026-11-27T10:00:00.000Z" }]);
    expect(book().revoke("makosh-commander", PROFILE)).toBe(true);
    expect(book().check("makosh-commander", PROFILE, "read")).toEqual({ ok: false, code: "consent_revoked" });
  });

  it("stores identifiers, a level and times, and one row per plugin and connection", () => {
    book().grant("makosh-commander", PROFILE, "write");
    book().grant("makosh-commander", PROFILE, "read");
    const rows = db.prepare("SELECT * FROM plugin_sftp_grants").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ plugin_id: "makosh-commander", profile_id: PROFILE, level: "read", granted_at: "2026-11-27T10:00:00.000Z", revoked_at: null, request_id: null });
    book().forgetProfile(PROFILE);
    expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_sftp_grants").get()).toEqual({ n: 0 });
  });

  it("a level this version does not know grants nothing", () => {
    book().grant("makosh-commander", PROFILE, "write");
    db.prepare("UPDATE plugin_sftp_grants SET level = 'admin'").run();
    expect(book().check("makosh-commander", PROFILE, "read").ok).toBe(false);
  });
});
