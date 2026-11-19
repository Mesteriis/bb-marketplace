import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "./migrations.ts";
import { createSqlitePveConsoleTabs, createSqlitePveGuestLinks } from "./pve-sqlite.ts";

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

describe("console tabs", () => {
  const tab = (id: string, over: Record<string, unknown> = {}) => ({ id, profileId: "env-a", console: "lxc" as const, node: null, vmid: 101, title: "web", ...over });

  it("keeps targets in the order they were opened, replaces by id, and removes", () => {
    const tabs = createSqlitePveConsoleTabs(db());
    tabs.put(tab("t1"), new Date("2026-11-19T10:00:00Z"));
    tabs.put(tab("t2", { console: "node", node: "pve1", vmid: null, title: "pve1" }), new Date("2026-11-19T10:01:00Z"));
    tabs.put(tab("t1", { title: "renamed" }), new Date("2026-11-19T10:00:00Z"));
    expect(tabs.list().map((t) => [t.id, t.title])).toEqual([["t1", "renamed"], ["t2", "pve1"]]);
    expect(tabs.remove("t1")).toBe(true);
    expect(tabs.remove("t1")).toBe(false);
  });

  it("keeps at most 24, dropping the oldest, and forgets a deleted connection's tabs", () => {
    const tabs = createSqlitePveConsoleTabs(db());
    for (let i = 0; i < 30; i++) tabs.put(tab("t" + i), new Date(Date.UTC(2026, 10, 19, 10, i)));
    const ids = tabs.list().map((t) => t.id);
    expect(ids).toHaveLength(24);
    expect(ids[0]).toBe("t6");
    tabs.put(tab("other", { profileId: "env-b" }), new Date("2026-11-19T12:00:00Z"));
    tabs.dropProfile("env-a");
    expect(tabs.list().map((t) => t.id)).toEqual(["other"]);
  });

  it("holds no column that could carry a secret or a session", () => {
    const d = db();
    const cols = (d.prepare("PRAGMA table_info(pve_console_tabs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["id", "pve_profile_id", "console", "node", "vmid", "title", "created_at"]);
  });
});
