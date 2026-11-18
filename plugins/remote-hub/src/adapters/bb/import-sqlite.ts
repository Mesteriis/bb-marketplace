// SQLite storage for import sources and the links from imported profiles back to them (stage 3c).
// Metadata only: a source is a path the user chose, a link is the key of an entry and the values last applied.
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ImportSource, ImportStore } from "../../core/import-book.ts";
import type { ImportLink, ImportedFields } from "../../core/import-plan.ts";

/** Append-only after CREDENTIAL_MIGRATIONS (bb.storage.migrate): never edit a shipped statement. */
export const IMPORT_MIGRATIONS: string[] = [
  `
  CREATE TABLE import_sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    use_ssh_g INTEGER NOT NULL
  );
  CREATE TABLE import_links (
    source_id TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    imported_json TEXT NOT NULL,
    resolved INTEGER NOT NULL,
    flags_json TEXT NOT NULL,
    stale INTEGER NOT NULL,
    PRIMARY KEY (source_id, entry_key)
  );
  CREATE INDEX import_links_profile ON import_links (profile_id);
  `,
];

const importedSchema = z
  .object({
    host: z.string(),
    port: z.number().int().nullable(),
    username: z.string().nullable(),
    authType: z.enum(["agent", "key"]),
    identityFile: z.string().nullable(),
  })
  .strict();

const kindSchema = z.enum(["ssh-config", "hosts", "keys-dir", "agent", "known-hosts"]);

interface SourceRow {
  id: string;
  kind: string;
  path: string | null;
  label: string;
  enabled: number;
  use_ssh_g: number;
}
interface LinkRow {
  source_id: string;
  entry_key: string;
  profile_id: string;
  imported_json: string;
  resolved: number;
  flags_json: string;
  stale: number;
}

export function createSqliteImportStore(db: Database.Database): ImportStore {
  return {
    sources(): ImportSource[] {
      const out: ImportSource[] = [];
      for (const row of db.prepare("SELECT * FROM import_sources ORDER BY rowid").all() as SourceRow[]) {
        const kind = kindSchema.safeParse(row.kind);
        if (!kind.success) continue; // a row this version does not know is left alone, not shown
        out.push({ id: row.id, kind: kind.data, path: row.path, label: row.label, enabled: row.enabled === 1, useSshG: row.use_ssh_g === 1 });
      }
      return out;
    },
    putSource(s) {
      db.prepare(
        `INSERT INTO import_sources (id, kind, path, label, enabled, use_ssh_g) VALUES (@id, @kind, @path, @label, @enabled, @use_ssh_g)
         ON CONFLICT(id) DO UPDATE SET kind=@kind, path=@path, label=@label, enabled=@enabled, use_ssh_g=@use_ssh_g`,
      ).run({ id: s.id, kind: s.kind, path: s.path, label: s.label, enabled: s.enabled ? 1 : 0, use_ssh_g: s.useSshG ? 1 : 0 });
    },
    removeSource(id) {
      return db.prepare("DELETE FROM import_sources WHERE id = ?").run(id).changes > 0;
    },
    links(sourceId?: string): ImportLink[] {
      const rows = (sourceId === undefined
        ? db.prepare("SELECT * FROM import_links").all()
        : db.prepare("SELECT * FROM import_links WHERE source_id = ?").all(sourceId)) as LinkRow[];
      const out: ImportLink[] = [];
      for (const row of rows) {
        let imported: ImportedFields;
        let flags: string[];
        try {
          imported = importedSchema.parse(JSON.parse(row.imported_json));
          flags = z.array(z.string()).parse(JSON.parse(row.flags_json));
        } catch {
          continue;
        }
        out.push({ profileId: row.profile_id, sourceId: row.source_id, key: row.entry_key, imported, resolved: row.resolved === 1, flags, stale: row.stale === 1 });
      }
      return out;
    },
    putLink(l) {
      db.prepare(
        `INSERT INTO import_links (source_id, entry_key, profile_id, imported_json, resolved, flags_json, stale)
         VALUES (@source_id, @entry_key, @profile_id, @imported_json, @resolved, @flags_json, @stale)
         ON CONFLICT(source_id, entry_key) DO UPDATE SET profile_id=@profile_id, imported_json=@imported_json, resolved=@resolved, flags_json=@flags_json, stale=@stale`,
      ).run({
        source_id: l.sourceId,
        entry_key: l.key,
        profile_id: l.profileId,
        imported_json: JSON.stringify(l.imported),
        resolved: l.resolved ? 1 : 0,
        flags_json: JSON.stringify(l.flags),
        stale: l.stale ? 1 : 0,
      });
    },
    removeLinksOfSource(sourceId) {
      db.prepare("DELETE FROM import_links WHERE source_id = ?").run(sourceId);
    },
  };
}
