import type { Database } from "better-sqlite3";
import { z } from "zod";
import { CommanderError } from "../../core/errors.ts";
import type { Checkpoint, JobStore } from "../../core/job-store.ts";
import { Fingerprint, Initiator, OperationJob, type OperationPlan } from "../../core/model.ts";
import { ResourcePath } from "../../core/path.ts";
import { Size } from "../../core/size.ts";

interface JobRow {
  row_id: string;
  id: string;
  plan_json: string;
  state: string;
  progress_json: string;
  current_item: number | null;
  pending_conflict_json: string | null;
  items_json: string;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  initiator_kind: string;
  thread_id: string | null;
  awaits_owner: number;
}

const TERMINAL_STATES = "('completed', 'failed', 'cancelled', 'unknown')";
const PATCH_FIELDS = new Set<PropertyKey>([
  "state", "progress", "currentItem", "pendingConflict", "items", "error", "updatedAt", "awaitsOwner",
]);
const TERMINAL_LIMIT = 1000;

const Timestamp = z.string().datetime();
const JobId = z.string().uuid();
const CheckpointValue = z.strictObject({
  jobId: JobId,
  itemIndex: z.number().int().min(0),
  phase: z.enum(["prepared", "copying", "committed", "verified", "source_removed"]),
  bytesDone: Size,
  tempPath: ResourcePath.nullable(),
  targetPath: ResourcePath.nullable(),
  expectTarget: z.union([Fingerprint, z.literal("absent")]).nullable(),
  verified: Fingerprint.pick({ size: true, sha256: true }).nullable(),
  committed: Fingerprint.optional(),
});

interface CheckpointRow {
  job_id: string;
  item_index: number;
  phase: string;
  bytes_done: string;
  temp_path_json: string | null;
  target_path_json: string | null;
  expect_target_json: string | null;
  verified_json: string | null;
  committed_json: string | null;
  at: string;
}

function decodeJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function encodeJson(value: object | string | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function mutableColumns(job: OperationJob) {
  return {
    state: job.state,
    progress_json: JSON.stringify(job.progress),
    current_item: job.currentItem,
    pending_conflict_json: encodeJson(job.pendingConflict),
    items_json: JSON.stringify(job.items),
    error_json: encodeJson(job.error),
    updated_at: normalizeTimestamp(job.updatedAt),
    awaits_owner: job.awaitsOwner ? 1 : 0,
  };
}

function decodeJob(row: JobRow): OperationJob | null {
  try {
    const job = OperationJob.parse({
      id: row.id,
      plan: decodeJson(row.plan_json),
      state: row.state,
      progress: decodeJson(row.progress_json),
      currentItem: row.current_item,
      pendingConflict: decodeJson(row.pending_conflict_json),
      items: decodeJson(row.items_json),
      error: decodeJson(row.error_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      awaitsOwner: z.literal([0, 1]).parse(row.awaits_owner) === 1,
    });
    const { initiator } = job.plan;
    const threadId = initiator.kind === "agent" ? initiator.threadId : null;
    return initiator.kind === row.initiator_kind && threadId === row.thread_id ? job : null;
  } catch {
    return null;
  }
}

function rowUuid(rowId: string, slot: number): string {
  // UUIDv8 carries every bit of the signed SQLite rowid without a lossy JS number.
  const hex = BigInt.asUintN(64, BigInt(rowId)).toString(16).padStart(16, "0");
  const prefix = slot.toString(16).padStart(8, "0");
  return `${prefix}-${hex.slice(0, 4)}-8000-8000-${hex.slice(4)}`;
}

function rowIdFromUuid(uuid: string): string | null {
  const parts = /^[0-9a-f]{8}-([0-9a-f]{4})-8000-8000-([0-9a-f]{12})$/.exec(uuid);
  return parts ? BigInt.asIntN(64, BigInt(`0x${parts[1]}${parts[2]}`)).toString() : null;
}

function unreadableJob(row: JobRow, id: string): OperationJob {
  // Present a terminal record with no executable resources. Keep the damaged
  // row intact for diagnosis and never allow a state update to revive it.
  const createdAt = Timestamp.safeParse(row.created_at).data ?? "1970-01-01T00:00:00.000Z";
  const initiator = Initiator.safeParse(row.initiator_kind === "owner"
    ? { kind: row.initiator_kind }
    : { kind: row.initiator_kind, threadId: row.thread_id });
  const plan: OperationPlan = {
    id,
    kind: "copy",
    createdAt,
    initiator: initiator.data ?? { kind: "owner" },
    sourceEndpoint: null,
    targetEndpoint: null,
    items: [{ source: null, target: null, kind: "other", fingerprint: null }],
    conflictPolicy: "ask",
    route: "same-endpoint",
    verify: "size",
    totalBytes: "0",
    digest: "0".repeat(64),
  };
  return OperationJob.parse({
    id,
    plan,
    state: "unknown",
    progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "0" },
    currentItem: null,
    pendingConflict: null,
    awaitsOwner: false,
    items: [{ outcome: "unknown", error: null }],
    error: { code: "internal", message: "Stored job is damaged", retryable: false },
    createdAt,
    updatedAt: Timestamp.safeParse(row.updated_at).data ?? createdAt,
  });
}

export function createSqliteJobStore(db: Database): JobStore {
  const insert = db.prepare(`
    INSERT INTO jobs (
      id, plan_json, state, progress_json, current_item, pending_conflict_json,
      items_json, error_json, created_at, updated_at, initiator_kind, thread_id, awaits_owner
    ) VALUES (
      @id, @plan_json, @state, @progress_json, @current_item, @pending_conflict_json,
      @items_json, @error_json, @created_at, @updated_at, @initiator_kind, @thread_id, @awaits_owner
    ) ON CONFLICT(id) DO NOTHING
  `);
  const beyondRetentionLimit = db.prepare("SELECT 1 FROM jobs LIMIT 1 OFFSET ?").pluck();
  const deleteCheckpoints = db.prepare("DELETE FROM checkpoints WHERE job_id = (SELECT id FROM jobs WHERE rowid = ?)");
  const deleteJob = db.prepare("DELETE FROM jobs WHERE rowid = ?");

  // Read rowid as text to keep all 64 bits.
  const jobRows = "SELECT CAST(rowid AS TEXT) AS row_id, * FROM jobs";
  const byId = db.prepare<[string], JobRow>(`${jobRows} WHERE id = ?`);
  const byRowId = db.prepare<[string], JobRow>(`${jobRows} WHERE rowid = ?`);
  const idExists = db.prepare("SELECT 1 FROM jobs WHERE id = ?").pluck();
  const byUpdate = db.prepare<[], JobRow>(`${jobRows} ORDER BY updated_at DESC, id ASC`);
  const countStoredTerminal = db.prepare<[], number>(
    `SELECT count(*) FROM jobs WHERE state IN ${TERMINAL_STATES}`,
  ).pluck();
  const storedNonterminal = db.prepare<[], JobRow>(`${jobRows} WHERE state NOT IN ${TERMINAL_STATES}`);
  const expiredRows = db.prepare<[string, number], { row_id: string }>(`
    SELECT CAST(row_id AS TEXT) AS row_id FROM (
      SELECT rowid AS row_id, id, updated_at FROM jobs WHERE state IN ${TERMINAL_STATES}
      UNION ALL
      SELECT rowid AS row_id, id, updated_at FROM jobs
      WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
    )
    ORDER BY updated_at DESC, id ASC LIMIT -1 OFFSET ?
  `);
  const updateJob = db.prepare(`
    UPDATE jobs SET state = @state, progress_json = @progress_json,
      current_item = @current_item, pending_conflict_json = @pending_conflict_json,
      items_json = @items_json, error_json = @error_json, updated_at = @updated_at,
      awaits_owner = @awaits_owner
    WHERE id = @id AND state = @expected
  `);
  const writeCheckpoint = db.prepare(`
    INSERT INTO checkpoints (
      job_id, item_index, phase, bytes_done, temp_path_json, target_path_json,
      expect_target_json, verified_json, committed_json, at
    )
    SELECT @jobId, @itemIndex, @phase, @bytesDone, @tempPath, @targetPath,
      @expectTarget, @verified, @committed, @at
    WHERE EXISTS (SELECT 1 FROM jobs WHERE id = @jobId)
    ON CONFLICT(job_id, item_index) DO UPDATE SET
      phase = excluded.phase, bytes_done = excluded.bytes_done,
      temp_path_json = excluded.temp_path_json, target_path_json = excluded.target_path_json,
      expect_target_json = excluded.expect_target_json, verified_json = excluded.verified_json,
      committed_json = excluded.committed_json, at = excluded.at
  `);
  const readCheckpoint = db.prepare<[string, number], CheckpointRow>(
    "SELECT * FROM checkpoints WHERE job_id = ? AND item_index = ?",
  );

  function findDamagedRowByAlias(id: string): JobRow | null {
    const rowId = rowIdFromUuid(id);
    const row = rowId === null ? undefined : byRowId.get(rowId);
    return row && !JobId.safeParse(row.id).success ? row : null;
  }

  function showRow(row: JobRow): OperationJob {
    const job = decodeJob(row);
    if (job) return job;
    const { data: validId } = JobId.safeParse(row.id);
    if (validId !== undefined) return unreadableJob(row, validId);

    // Each slot encodes the same rowid. Skip physical IDs already stored.
    for (let slot = 0; slot <= 0xffffffff; slot++) {
      const alias = rowUuid(row.row_id, slot);
      if (!idExists.get(alias)) return unreadableJob(row, alias);
    }
    throw new CommanderError("internal", "No available identifier for the damaged job");
  }

  const create = db.transaction((input: OperationJob) => {
    const job = OperationJob.parse(input);
    // Reserve aliases while their damaged row exists, so a stale listed
    // alias can never resolve to a newly created healthy job.
    if (findDamagedRowByAlias(job.id)) throw new CommanderError("already_exists", "Job already exists");
    const { initiator } = job.plan;
    const { changes } = insert.run({
      ...mutableColumns(job),
      id: job.id,
      plan_json: JSON.stringify(job.plan),
      created_at: normalizeTimestamp(job.createdAt),
      initiator_kind: initiator.kind,
      thread_id: initiator.kind === "agent" ? initiator.threadId : null,
    });
    if (changes !== 1) throw new CommanderError("already_exists", "Job already exists");
    if (!beyondRetentionLimit.get(TERMINAL_LIMIT)) return;

    const storedTerminalCount = countStoredTerminal.get() ?? 0;
    const damagedRowIds: string[] = [];
    for (const row of storedNonterminal.iterate()) {
      if (!decodeJob(row)) damagedRowIds.push(row.row_id);
    }
    if (storedTerminalCount + damagedRowIds.length <= TERMINAL_LIMIT) return;

    const expired = expiredRows.all(JSON.stringify(damagedRowIds), TERMINAL_LIMIT);
    for (const { row_id } of expired) {
      deleteCheckpoints.run(row_id);
      deleteJob.run(row_id);
    }
  });

  const update = db.transaction((id: string, patch: Parameters<JobStore["update"]>[1], expected: OperationJob["state"]) => {
    if (Reflect.ownKeys(patch).some((key) => !PATCH_FIELDS.has(key))) {
      throw new CommanderError("internal", "Job update contains an unsupported field");
    }
    const row = byId.get(id);
    if (!row || row.state !== expected) return false;
    const job = decodeJob(row);
    if (!job) return false;

    const next = { ...job, ...patch };
    if (job.state === "pending" && next.state !== "pending" && patch.awaitsOwner === undefined) {
      next.awaitsOwner = false;
    }
    return updateJob.run({ ...mutableColumns(OperationJob.parse(next)), id, expected }).changes === 1;
  });

  return {
    async create(job) {
      create.immediate(job);
    },
    async get(id) {
      const row = byId.get(id);
      if (row) return showRow(row);
      const damaged = findDamagedRowByAlias(id);
      return damaged ? unreadableJob(damaged, id) : null;
    },
    async list({ states, limit }) {
      if (limit <= 0 || states?.length === 0) return [];
      const jobs: OperationJob[] = [];
      // An unreadable row is `unknown` regardless of its stored state.
      // Decode before filtering and stop as soon as the page is full.
      for (const row of byUpdate.iterate()) {
        const job = showRow(row);
        if (!states || states.includes(job.state)) jobs.push(job);
        if (jobs.length >= limit) break;
      }
      return jobs;
    },
    async update(id, patch, expected) {
      // Acquire the write lock before reading the row used to validate the patch.
      return update.immediate(id, patch, expected);
    },
    async checkpoint(input: Checkpoint) {
      const checkpoint = CheckpointValue.parse(input);
      const { changes } = writeCheckpoint.run({
        ...checkpoint,
        tempPath: encodeJson(checkpoint.tempPath),
        targetPath: encodeJson(checkpoint.targetPath),
        expectTarget: encodeJson(checkpoint.expectTarget),
        verified: encodeJson(checkpoint.verified),
        committed: encodeJson(checkpoint.committed ?? null),
        at: new Date().toISOString(),
      });
      if (changes !== 1) throw new CommanderError("not_found", "Job not found");
    },
    async lastCheckpoint(jobId, itemIndex) {
      const row = readCheckpoint.get(jobId, itemIndex);
      if (!row) return null;
      try {
        Timestamp.parse(row.at);
        return CheckpointValue.parse({
          jobId: row.job_id,
          itemIndex: row.item_index,
          phase: row.phase,
          bytesDone: row.bytes_done,
          tempPath: decodeJson(row.temp_path_json),
          targetPath: decodeJson(row.target_path_json),
          expectTarget: decodeJson(row.expect_target_json),
          verified: decodeJson(row.verified_json),
          ...(row.committed_json === null ? {} : { committed: decodeJson(row.committed_json) }),
        });
      } catch {
        throw new CommanderError("internal", "Stored checkpoint is damaged");
      }
    },
  };
}
