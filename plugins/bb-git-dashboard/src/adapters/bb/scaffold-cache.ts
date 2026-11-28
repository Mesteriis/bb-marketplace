import type { Revision } from "../../core/scaffolds/github-source.ts";
import type { ReviewDb } from "./review-store.ts";

/** The table of the templates' cache: one row per repository and branch, the archive of its last good revision. */
export const SCAFFOLD_CACHE_MIGRATIONS: string[] = [
  `CREATE TABLE scaffold_cache (
     repository TEXT NOT NULL,
     branch TEXT NOT NULL,
     sha TEXT NOT NULL,
     committed_at TEXT NOT NULL,
     etag TEXT,
     checked_at TEXT NOT NULL,
     archive BLOB NOT NULL,
     PRIMARY KEY (repository, branch)
   )`,
];

/** A revision held: its archive as GitHub served it (gzip), and when GitHub last answered for its branch. */
export type Cached = Revision & {checkedAt: string; archive: Uint8Array};
type Row = {repository: string; branch: string; sha: string; committed_at: string; etag: string | null; checked_at: string; archive: Uint8Array};

/**
 * The last good revision of the templates repository, in the plugin's database. Only GitHub's answers are kept —
 * the archive, the commit and the ETag — nothing derived from a token. A revision is bound to its repository and
 * branch: another pair never reads it, and keeping one pair drops the others.
 */
export class ScaffoldCache {
  private readonly db: ReviewDb;
  constructor(db: ReviewDb) { this.db = db; }
  get(repository: string, branch: string): Cached | null {
    const row = this.db.prepare("SELECT * FROM scaffold_cache WHERE repository = ? AND branch = ?").get(repository, branch) as Row | undefined;
    return row ? {repository: row.repository, branch: row.branch, sha: row.sha, committedAt: row.committed_at, etag: row.etag,
      checkedAt: row.checked_at, archive: new Uint8Array(row.archive)} : null;
  }
  /** Keeps this revision as the only one held. */
  put(entry: Cached) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM scaffold_cache").run();
      this.db.prepare("INSERT INTO scaffold_cache (repository, branch, sha, committed_at, etag, checked_at, archive) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(entry.repository, entry.branch, entry.sha, entry.committedAt, entry.etag, entry.checkedAt, entry.archive);
    })();
  }
  /** GitHub answered again for the held revision: when, and the ETag it gave. */
  touch(repository: string, branch: string, checkedAt: string, etag?: string | null) {
    if (etag === undefined) this.db.prepare("UPDATE scaffold_cache SET checked_at = ? WHERE repository = ? AND branch = ?").run(checkedAt, repository, branch);
    else this.db.prepare("UPDATE scaffold_cache SET checked_at = ?, etag = ? WHERE repository = ? AND branch = ?").run(checkedAt, etag, repository, branch);
  }
}
