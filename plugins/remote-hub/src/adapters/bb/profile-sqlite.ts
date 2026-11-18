// SQLite store for saved profiles (stage 3a), over the plugin's own database
// (bb.storage.database()). Explicit columns, no JSON blob of the profile, so
// there is no place a secret could hide: the table holds metadata and the
// opaque credentialRef only.
import type Database from "better-sqlite3";
import { profileSchema, type Profile } from "../../core/profile.ts";
import type { ProfileStore } from "../../core/profile-book.ts";

/** Append-only (bb.storage.migrate): never edit or reorder a shipped statement. */
export const PROFILE_MIGRATIONS: string[] = [
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    grp TEXT,
    tags TEXT NOT NULL,
    favorite INTEGER NOT NULL,
    color TEXT,
    host TEXT NOT NULL,
    port INTEGER,
    username TEXT,
    domain TEXT,
    auth_type TEXT NOT NULL,
    identity_file TEXT,
    credential_ref TEXT,
    rdp_width INTEGER,
    rdp_height INTEGER,
    execution_host_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT,
    recent_errors TEXT NOT NULL
  );
  `,
];

/** Statements for the profiles table that came after other tables existed: they run after them (see migrations.ts). */
export const PROFILE_LATER_MIGRATIONS: string[] = [
  // An imported alias that depends on SSH configuration cannot save a secret; the restriction lives with the profile.
  `ALTER TABLE profiles ADD COLUMN needs_config INTEGER NOT NULL DEFAULT 0;`,
];

/**
 * RDP connection options (compression, colour depth, experience). Added after other tables existed, so it runs at the END
 * of the ordered list (see migrations.ts). Profiles saved before it get the default for a VPN/WAN link (Balanced).
 */
export const PROFILE_RDP_OPTIONS_MIGRATIONS: string[] = [
  `ALTER TABLE profiles ADD COLUMN rdp_options TEXT;`,
  `UPDATE profiles SET rdp_options = '{"compression":true,"colorDepth":32,"wallpaper":false,"fullWindowDrag":false,"menuAnimations":false,"fontSmoothing":true,"desktopComposition":false,"themes":true}' WHERE protocol = 'rdp' AND rdp_options IS NULL;`,
];

/** The API certificate trust of a PVE profile (JSON; null = the system roots). Runs at the END of the ordered list. */
export const PROFILE_PVE_MIGRATIONS: string[] = [`ALTER TABLE profiles ADD COLUMN pve_trust TEXT;`];

interface Row {
  id: string;
  name: string;
  protocol: string;
  grp: string | null;
  tags: string;
  favorite: number;
  color: string | null;
  host: string;
  port: number | null;
  username: string | null;
  domain: string | null;
  auth_type: string;
  identity_file: string | null;
  credential_ref: string | null;
  rdp_width: number | null;
  rdp_height: number | null;
  execution_host_id: string;
  origin: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  recent_errors: string;
  needs_config: number;
  rdp_options: string | null;
  pve_trust: string | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fromRow(row: Row): Profile | null {
  const parsed = profileSchema.safeParse({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    group: row.grp,
    tags: parseJson(row.tags),
    favorite: row.favorite === 1,
    color: row.color,
    host: row.host,
    port: row.port,
    username: row.username,
    domain: row.domain,
    authType: row.auth_type,
    identityFile: row.identity_file,
    credentialRef: row.credential_ref,
    rdpWidth: row.rdp_width,
    rdpHeight: row.rdp_height,
    ...(row.rdp_options === null ? {} : { rdpOptions: parseJson(row.rdp_options) }),
    ...(row.pve_trust === null ? {} : { pveTrust: parseJson(row.pve_trust) }),
    executionHostId: row.execution_host_id,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    recentErrors: parseJson(row.recent_errors),
    ...(row.needs_config === 1 ? { needsConfig: true } : {}),
  });
  return parsed.success ? parsed.data : null;
}

export function createSqliteProfileStore(db: Database.Database): ProfileStore {
  const selectAll = db.prepare("SELECT * FROM profiles ORDER BY created_at, id");
  const selectOne = db.prepare("SELECT * FROM profiles WHERE id = ?");
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO profiles (
      id, name, protocol, grp, tags, favorite, color, host, port, username, domain, auth_type,
      identity_file, credential_ref, rdp_width, rdp_height, execution_host_id, origin,
      created_at, updated_at, last_opened_at, recent_errors, needs_config, rdp_options, pve_trust
    ) VALUES (
      @id, @name, @protocol, @grp, @tags, @favorite, @color, @host, @port, @username, @domain, @auth_type,
      @identity_file, @credential_ref, @rdp_width, @rdp_height, @execution_host_id, @origin,
      @created_at, @updated_at, @last_opened_at, @recent_errors, @needs_config, @rdp_options, @pve_trust
    )
  `);
  const del = db.prepare("DELETE FROM profiles WHERE id = ?");
  return {
    // A row that no longer validates (edited by hand, older shape) is left out
    // rather than breaking the whole catalogue.
    all: () => (selectAll.all() as Row[]).flatMap((row) => fromRow(row) ?? []),
    get: (id) => {
      const row = selectOne.get(id) as Row | undefined;
      return row === undefined ? null : fromRow(row);
    },
    put: (p) => {
      upsert.run({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        grp: p.group,
        tags: JSON.stringify(p.tags),
        favorite: p.favorite ? 1 : 0,
        color: p.color,
        host: p.host,
        port: p.port,
        username: p.username,
        domain: p.domain,
        auth_type: p.authType,
        identity_file: p.identityFile,
        credential_ref: p.credentialRef,
        rdp_width: p.rdpWidth,
        rdp_height: p.rdpHeight,
        execution_host_id: p.executionHostId,
        origin: p.origin,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
        last_opened_at: p.lastOpenedAt,
        recent_errors: JSON.stringify(p.recentErrors),
        needs_config: p.needsConfig === true ? 1 : 0,
        rdp_options: p.rdpOptions === null || p.rdpOptions === undefined ? null : JSON.stringify(p.rdpOptions),
        pve_trust: p.pveTrust === null || p.pveTrust === undefined ? null : JSON.stringify(p.pveTrust),
      });
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
