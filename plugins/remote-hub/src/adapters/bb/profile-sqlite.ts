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
    executionHostId: row.execution_host_id,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    recentErrors: parseJson(row.recent_errors),
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
      created_at, updated_at, last_opened_at, recent_errors
    ) VALUES (
      @id, @name, @protocol, @grp, @tags, @favorite, @color, @host, @port, @username, @domain, @auth_type,
      @identity_file, @credential_ref, @rdp_width, @rdp_height, @execution_host_id, @origin,
      @created_at, @updated_at, @last_opened_at, @recent_errors
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
      });
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
