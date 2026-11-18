import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRdpTrustStore } from "../../core/rdp-trust.ts";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { createSqliteRdpTrust } from "./rdp-trust-sqlite.ts";

const FP = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  for (const statement of ALL_MIGRATIONS) db.exec(statement);
});
afterEach(() => db.close());

describe("sqlite RDP trust", () => {
  it("keeps one row per exact certificate and nothing but host, port, fingerprint and time", () => {
    const store = createRdpTrustStore(createSqliteRdpTrust(db));
    store.trustAlways("Win.Example.TEST", 3389, FP, new Date("2026-11-18T10:00:00.000Z"));
    store.trustAlways("win.example.test", 3389, FP, new Date("2026-11-18T11:00:00.000Z"));
    const rows = db.prepare("SELECT * FROM rdp_trusted_certs").all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ host: "win.example.test", port: 3389, fingerprint: FP, added_at: "2026-11-18T10:00:00.000Z" }]);
  });

  it("is read back by a new store (a restart) and forgetting deletes the row", () => {
    createRdpTrustStore(createSqliteRdpTrust(db)).trustAlways("h", 3389, FP, new Date("2026-11-18T10:00:00.000Z"));
    const after = createRdpTrustStore(createSqliteRdpTrust(db));
    expect(after.isTrusted("h", 3389, FP)).toBe(true);
    expect(after.forget("h", 3389, FP)).toBe(true);
    expect(createRdpTrustStore(createSqliteRdpTrust(db)).isTrusted("h", 3389, FP)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rdp_trusted_certs").get()).toEqual({ n: 0 });
  });
});
