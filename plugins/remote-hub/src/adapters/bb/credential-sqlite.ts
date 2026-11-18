// SQLite metadata for saved credentials (stage 3b). The secret is NOT here: it is
// in the Keychain under the `ref`. Explicit columns, so there is no place a secret
// could be stored by accident.
import type Database from "better-sqlite3";
import { credentialMetaSchema, type CredentialMeta } from "../../core/credential.ts";
import type { CredentialMetaStore } from "../../core/credential.ts";

/** Append-only after PROFILE_MIGRATIONS (bb.storage.migrate): never edit a shipped statement. */
export const CREDENTIAL_MIGRATIONS: string[] = [
  `
  CREATE TABLE credentials (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    bind_type TEXT NOT NULL,
    bind_protocol TEXT,
    bind_host TEXT,
    bind_port INTEGER,
    bind_user TEXT,
    bind_domain TEXT,
    bind_path TEXT,
    execution_host_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

interface Row {
  ref: string;
  kind: string;
  label: string;
  bind_type: string;
  bind_protocol: string | null;
  bind_host: string | null;
  bind_port: number | null;
  bind_user: string | null;
  bind_domain: string | null;
  bind_path: string | null;
  execution_host_id: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): CredentialMeta | null {
  const bind =
    row.bind_type === "key"
      ? { type: "key", path: row.bind_path }
      : { type: "endpoint", protocol: row.bind_protocol, host: row.bind_host, port: row.bind_port, user: row.bind_user, domain: row.bind_domain };
  const parsed = credentialMetaSchema.safeParse({
    ref: row.ref,
    kind: row.kind,
    label: row.label,
    bind,
    executionHostId: row.execution_host_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

export function createSqliteCredentialStore(db: Database.Database): CredentialMetaStore {
  const selectAll = db.prepare("SELECT * FROM credentials ORDER BY created_at, ref");
  const selectOne = db.prepare("SELECT * FROM credentials WHERE ref = ?");
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO credentials (
      ref, kind, label, bind_type, bind_protocol, bind_host, bind_port, bind_user, bind_domain, bind_path,
      execution_host_id, created_at, updated_at
    ) VALUES (
      @ref, @kind, @label, @bind_type, @bind_protocol, @bind_host, @bind_port, @bind_user, @bind_domain, @bind_path,
      @execution_host_id, @created_at, @updated_at
    )
  `);
  const del = db.prepare("DELETE FROM credentials WHERE ref = ?");
  return {
    all: () => (selectAll.all() as Row[]).flatMap((row) => fromRow(row) ?? []),
    get: (ref) => {
      const row = selectOne.get(ref) as Row | undefined;
      return row === undefined ? null : fromRow(row);
    },
    put: (m) => {
      const endpoint = m.bind.type === "endpoint" ? m.bind : null;
      upsert.run({
        ref: m.ref,
        kind: m.kind,
        label: m.label,
        bind_type: m.bind.type,
        bind_protocol: endpoint?.protocol ?? null,
        bind_host: endpoint?.host ?? null,
        bind_port: endpoint?.port ?? null,
        bind_user: endpoint?.user ?? null,
        bind_domain: endpoint?.domain ?? null,
        bind_path: m.bind.type === "key" ? m.bind.path : null,
        execution_host_id: m.executionHostId,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
      });
    },
    remove: (ref) => del.run(ref).changes > 0,
  };
}
