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
  `
    ALTER TABLE checkpoints ADD COLUMN writing_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN cleanup_json TEXT;
    ALTER TABLE checkpoints ADD COLUMN source_hash TEXT;
  `,
  `
  CREATE INDEX IF NOT EXISTS jobs_agent_updated_at ON jobs (thread_id, updated_at DESC, id ASC)
    WHERE initiator_kind = 'agent';
  CREATE TABLE IF NOT EXISTS commander_owner_approvals (job_id TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS commander_record_owner_approval AFTER UPDATE OF state ON jobs
    WHEN old.awaits_owner = 1 AND new.state = 'running'
    BEGIN INSERT OR IGNORE INTO commander_owner_approvals VALUES (new.id); END;
  CREATE TRIGGER IF NOT EXISTS commander_forget_owner_approval AFTER DELETE ON jobs
    BEGIN DELETE FROM commander_owner_approvals WHERE job_id = old.id; END;
`,
  `
    CREATE INDEX IF NOT EXISTS jobs_pending_owner_by_thread ON jobs (thread_id)
      WHERE state = 'pending' AND awaits_owner = 1 AND initiator_kind = 'agent';
    CREATE INDEX IF NOT EXISTS jobs_agent_thread_scan ON jobs (thread_id) WHERE initiator_kind = 'agent';
  `,
  `
    CREATE TABLE IF NOT EXISTS scan_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'cancelled', 'interrupted')),
      job_json TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE checkpoints ADD COLUMN commit_intent_json TEXT;
  `,
  `
    CREATE TABLE IF NOT EXISTS archives (
      id TEXT PRIMARY KEY NOT NULL,
      source_json TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_referenced_at TEXT NOT NULL
    );
  `,
];
