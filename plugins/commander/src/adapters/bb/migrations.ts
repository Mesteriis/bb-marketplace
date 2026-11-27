// Append only. BB identifies each migration by its position and SQL hash.
export const MIGRATIONS: string[] = [
  `
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      plan_json TEXT NOT NULL,
      state TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      current_item INTEGER,
      pending_conflict_json TEXT,
      items_json TEXT NOT NULL,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      initiator_kind TEXT NOT NULL,
      thread_id TEXT,
      awaits_owner INTEGER NOT NULL DEFAULT 0
        CHECK (awaits_owner IN (0, 1) AND (awaits_owner = 0 OR state = 'pending'))
    );

    CREATE INDEX IF NOT EXISTS jobs_state_updated_at ON jobs (state, updated_at);

    CREATE TABLE IF NOT EXISTS checkpoints (
      job_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      phase TEXT NOT NULL,
      bytes_done TEXT NOT NULL,
      temp_path_json TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY (job_id, item_index)
    );
  `,
  `
    ALTER TABLE checkpoints ADD COLUMN target_path_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN expect_target_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN verified_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN committed_json TEXT;
  `,
  `
    ALTER TABLE checkpoints ADD COLUMN temp_fingerprint_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN via TEXT CHECK (via IN ('rename', 'copy'));
  `,
];
