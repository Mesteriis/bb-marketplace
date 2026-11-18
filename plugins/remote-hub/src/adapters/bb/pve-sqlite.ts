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
];

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
