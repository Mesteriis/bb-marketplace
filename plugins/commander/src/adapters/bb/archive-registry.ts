import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JobStore } from "../../core/job-store.ts";
import { Fingerprint, ResourceRef, type JobState, type OperationJob } from "../../core/model.ts";

/**
 * Archive registry (S14 spec §7). Persists only what a restart needs to find the source of an
 * `archive:<uuid>` endpoint: the source ref and its version. No limits, passwords or copy paths.
 */

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_SCAN_LIMIT = 1000;
/** A job in one of these states keeps its archive row alive. */
const UNFINISHED: JobState[] = ["pending", "running", "awaiting_decision", "interrupted", "cancel_requested", "unknown"];
const SourceVersion = Fingerprint.pick({ size: true, mtimeNs: true }).strict();

interface Row {
  id: string;
  source_json: string;
  fingerprint_json: string;
  created_at: string;
  last_referenced_at: string;
}

export interface ArchiveRegistry {
  register(source: ResourceRef, fingerprint: z.infer<typeof SourceVersion>, id?: string): string;
  get(id: string): { source: ResourceRef; fingerprint: z.infer<typeof SourceVersion> } | null;
  /** The panel is closed or a referencing job ended: the retention clock restarts. */
  release(id: string): void;
  releaseForJob(job: OperationJob): Promise<void>;
  /** Deletes rows with no unfinished-job reference whose last release is older than seven days. */
  purge(): Promise<number>;
}

export function archiveIdOf(endpoint: string): string | null {
  return endpoint.startsWith("archive:") ? endpoint.slice("archive:".length) : null;
}

function archiveIdsOf(job: OperationJob): Set<string> {
  const ids = new Set<string>();
  const add = (endpoint: string | null | undefined) => {
    const id = endpoint ? archiveIdOf(endpoint) : null;
    if (id) ids.add(id);
  };
  add(job.plan.sourceEndpoint);
  add(job.plan.targetEndpoint);
  for (const item of job.plan.items) {
    add(item.source?.endpoint);
    add(item.target?.endpoint);
  }
  return ids;
}

export function createArchiveRegistry(deps: {
  db: Database.Database;
  jobs: JobStore;
  now?: () => Date;
  uuid?: () => string;
}): ArchiveRegistry {
  const { db, jobs } = deps;
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const insert = db.prepare(
    "INSERT INTO archives (id, source_json, fingerprint_json, created_at, last_referenced_at) VALUES (@id, @source, @fingerprint, @at, @at)",
  );
  const read = db.prepare<[string], Row>("SELECT * FROM archives WHERE id = ?");
  const touch = db.prepare("UPDATE archives SET last_referenced_at = ? WHERE id = ?");
  const stale = db.prepare<[string], { id: string }>("SELECT id FROM archives WHERE last_referenced_at < ?");
  const remove = db.prepare("DELETE FROM archives WHERE id = ?");

  return {
    register(source, fingerprint, given) {
      const id = given ?? uuid();
      insert.run({
        id,
        source: JSON.stringify(ResourceRef.parse(source)),
        fingerprint: JSON.stringify(SourceVersion.parse({ size: fingerprint.size, mtimeNs: fingerprint.mtimeNs })),
        at: now().toISOString(),
      });
      return id;
    },
    get(id) {
      const row = read.get(id);
      if (!row) return null;
      return {
        source: ResourceRef.parse(JSON.parse(row.source_json)),
        fingerprint: SourceVersion.parse(JSON.parse(row.fingerprint_json)),
      };
    },
    release(id) {
      touch.run(now().toISOString(), id);
    },
    async releaseForJob(job) {
      for (const id of archiveIdsOf(job)) touch.run(now().toISOString(), id);
    },
    async purge() {
      const referenced = new Set<string>();
      for (const job of await jobs.list({ states: UNFINISHED, limit: JOB_SCAN_LIMIT })) {
        for (const id of archiveIdsOf(job)) referenced.add(id);
      }
      let deleted = 0;
      const cutoff = new Date(now().getTime() - RETENTION_MS).toISOString();
      for (const { id } of stale.all(cutoff)) {
        if (referenced.has(id)) continue;
        remove.run(id);
        deleted++;
      }
      return deleted;
    },
  };
}
