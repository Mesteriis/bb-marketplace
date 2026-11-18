import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { createSqlitePveGuestLinks } from "./pve-sqlite.ts";

function db(): Database.Database {
  const d = new Database(":memory:");
  for (const s of ALL_MIGRATIONS) d.exec(s);
  return d;
}

describe("guest links", () => {
  it("keeps the owner's choice per PVE profile and VMID, so equal VMIDs of two environments stay apart", () => {
    const links = createSqlitePveGuestLinks(db());
    links.set("env-a", 100, "ssh-a");
    links.set("env-b", 100, "rdp-b");
    expect([...links.forProfile("env-a")]).toEqual([[100, "ssh-a"]]);
    expect([...links.forProfile("env-b")]).toEqual([[100, "rdp-b"]]);
    links.set("env-a", 100, "ssh-a2");
    expect(links.forProfile("env-a").get(100)).toBe("ssh-a2");
  });

  it("clears one link, and drops every link of a deleted profile on either side", () => {
    const links = createSqlitePveGuestLinks(db());
    links.set("env-a", 100, "ssh-a");
    links.set("env-a", 101, "ssh-x");
    links.set("env-b", 5, "ssh-a");
    expect(links.clear("env-a", 100)).toBe(true);
    expect(links.clear("env-a", 100)).toBe(false);
    links.dropProfile("ssh-a");
    expect([...links.forProfile("env-b")]).toEqual([]);
    expect([...links.forProfile("env-a")]).toEqual([[101, "ssh-x"]]);
    links.dropProfile("env-a");
    expect([...links.forProfile("env-a")]).toEqual([]);
  });
});
