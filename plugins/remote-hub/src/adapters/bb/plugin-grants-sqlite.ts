// SQLite storage for what the owner allowed other plugins to do over SFTP (core/plugin-grants.ts). Identifiers, a level
// and times; the reason a plugin gave for asking is its own short text. Nothing secret.
import type Database from "better-sqlite3";
import type { PluginGrantRow, PluginGrantStore } from "../../core/plugin-grants.ts";
import { SFTP_LEVELS, type SftpLevel } from "../../core/sftp-contract.ts";

/** Appended after every earlier statement (see migrations.ts). */
export const PLUGIN_GRANT_MIGRATIONS: string[] = [
  `CREATE TABLE plugin_sftp_grants (
    plugin_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    level TEXT,
    granted_at TEXT,
    grant_id TEXT,
    revoked_at TEXT,
    request_id TEXT,
    request_level TEXT,
    request_reason TEXT,
    requested_at TEXT,
    PRIMARY KEY (plugin_id, profile_id)
  );`,
];

interface Row {
  plugin_id: string;
  profile_id: string;
  level: string | null;
  granted_at: string | null;
  grant_id: string | null;
  revoked_at: string | null;
  request_id: string | null;
  request_level: string | null;
  request_reason: string | null;
  requested_at: string | null;
}

const levelOf = (value: string | null): SftpLevel | null => ((SFTP_LEVELS as readonly string[]).includes(value ?? "") ? (value as SftpLevel) : null);

function toRow(row: Row): PluginGrantRow {
  const requestLevel = levelOf(row.request_level);
  return {
    pluginId: row.plugin_id,
    profileId: row.profile_id,
    // A level this version does not know grants nothing.
    level: levelOf(row.level),
    grantedAt: row.granted_at,
    grantId: row.grant_id,
    revokedAt: row.revoked_at,
    request: row.request_id !== null && requestLevel !== null && row.requested_at !== null ? { requestId: row.request_id, level: requestLevel, reason: row.request_reason, requestedAt: row.requested_at } : null,
  };
}

export function createSqlitePluginGrantStore(db: Database.Database): PluginGrantStore {
  return {
    all: () => (db.prepare("SELECT * FROM plugin_sftp_grants ORDER BY plugin_id, profile_id").all() as Row[]).map(toRow),
    get(pluginId, profileId) {
      const row = db.prepare("SELECT * FROM plugin_sftp_grants WHERE plugin_id = ? AND profile_id = ?").get(pluginId, profileId) as Row | undefined;
      return row === undefined ? null : toRow(row);
    },
    put(row) {
      db.prepare(
        `INSERT INTO plugin_sftp_grants (plugin_id, profile_id, level, granted_at, grant_id, revoked_at, request_id, request_level, request_reason, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id, profile_id) DO UPDATE SET level = excluded.level, granted_at = excluded.granted_at, grant_id = excluded.grant_id, revoked_at = excluded.revoked_at,
           request_id = excluded.request_id, request_level = excluded.request_level, request_reason = excluded.request_reason, requested_at = excluded.requested_at`,
      ).run(row.pluginId, row.profileId, row.level, row.grantedAt, row.grantId, row.revokedAt, row.request?.requestId ?? null, row.request?.level ?? null, row.request?.reason ?? null, row.request?.requestedAt ?? null);
    },
    remove: (pluginId, profileId) => db.prepare("DELETE FROM plugin_sftp_grants WHERE plugin_id = ? AND profile_id = ?").run(pluginId, profileId).changes > 0,
  };
}
