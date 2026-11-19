// SQLite store for the links the owner makes between a Proxmox guest and a saved SSH/RDP profile. The link is the
// owner's choice (never a guessed address); the guest is named by the PVE profile and its VMID, so equal VMIDs of two
// environments never meet. Append-only migrations, like every other table here.
import type Database from "better-sqlite3";

export const PVE_MIGRATIONS: string[] = [
  `
  CREATE TABLE pve_guest_links (
    pve_profile_id TEXT NOT NULL,
    vmid INTEGER NOT NULL,
    link_profile_id TEXT NOT NULL,
    PRIMARY KEY (pve_profile_id, vmid)
  );
  `,
  // The console tabs the owner had open: targets only (connection, kind, node or VMID, a title), never a session, a ticket or a secret.
  `
  CREATE TABLE pve_console_tabs (
    id TEXT PRIMARY KEY,
    pve_profile_id TEXT NOT NULL,
    console TEXT NOT NULL,
    node TEXT,
    vmid INTEGER,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];

/** A console tab as it is kept: where it pointed, not what it was connected to. */
export interface PveConsoleTabRow {
  id: string;
  profileId: string;
  console: "node" | "lxc" | "qemu";
  node: string | null;
  vmid: number | null;
  title: string;
}

export const MAX_CONSOLE_TABS = 24;

export interface PveConsoleTabStore {
  list(): PveConsoleTabRow[];
  /** Adds (or replaces) a tab; the oldest ones beyond the cap are dropped. */
  put(tab: PveConsoleTabRow, now: Date): void;
  remove(id: string): boolean;
  dropProfile(profileId: string): void;
}

export function createSqlitePveConsoleTabs(db: Database.Database): PveConsoleTabStore {
  const all = db.prepare("SELECT id, pve_profile_id, console, node, vmid, title FROM pve_console_tabs ORDER BY created_at, rowid");
  const upsert = db.prepare("INSERT OR REPLACE INTO pve_console_tabs (id, pve_profile_id, console, node, vmid, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const del = db.prepare("DELETE FROM pve_console_tabs WHERE id = ?");
  const drop = db.prepare("DELETE FROM pve_console_tabs WHERE pve_profile_id = ?");
  const trim = db.prepare("DELETE FROM pve_console_tabs WHERE id IN (SELECT id FROM pve_console_tabs ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)");
  return {
    list: () => (all.all() as Array<{ id: string; pve_profile_id: string; console: PveConsoleTabRow["console"]; node: string | null; vmid: number | null; title: string }>).map((r) => ({ id: r.id, profileId: r.pve_profile_id, console: r.console, node: r.node, vmid: r.vmid, title: r.title })),
    put: (t, now) => {
      upsert.run(t.id, t.profileId, t.console, t.node, t.vmid, t.title, now.toISOString());
      trim.run(MAX_CONSOLE_TABS);
    },
    remove: (id) => del.run(id).changes > 0,
    dropProfile: (id) => void drop.run(id),
  };
}

export interface PveGuestLinkStore {
  /** The linked SSH/RDP profile of each guest of one PVE profile: vmid -> profile id. */
  forProfile(pveProfileId: string): Map<number, string>;
  set(pveProfileId: string, vmid: number, linkProfileId: string): void;
  clear(pveProfileId: string, vmid: number): boolean;
  /** Drops every link that mentions a deleted profile (as the PVE profile or as the target). */
  dropProfile(profileId: string): void;
}

export function createSqlitePveGuestLinks(db: Database.Database): PveGuestLinkStore {
  const select = db.prepare("SELECT vmid, link_profile_id FROM pve_guest_links WHERE pve_profile_id = ?");
  const upsert = db.prepare("INSERT OR REPLACE INTO pve_guest_links (pve_profile_id, vmid, link_profile_id) VALUES (?, ?, ?)");
  const del = db.prepare("DELETE FROM pve_guest_links WHERE pve_profile_id = ? AND vmid = ?");
  const drop = db.prepare("DELETE FROM pve_guest_links WHERE pve_profile_id = ? OR link_profile_id = ?");
  return {
    forProfile: (id) => new Map((select.all(id) as Array<{ vmid: number; link_profile_id: string }>).map((r) => [r.vmid, r.link_profile_id])),
    set: (id, vmid, link) => void upsert.run(id, vmid, link),
    clear: (id, vmid) => del.run(id, vmid).changes > 0,
    dropProfile: (id) => void drop.run(id, id),
  };
}
