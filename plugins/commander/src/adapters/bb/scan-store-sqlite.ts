import type { Database } from "better-sqlite3";
import { CommanderError } from "../../core/errors.ts";
import type { ScanJob, ScanStore } from "../../core/scan-job.ts";
import { ScanJobView } from "../../core/wire/rpc.ts";

export function scanJobView(job: ScanJob) {
  return {
    ...job,
    progress: {
      ...job.progress,
      bytes: job.progress.bytes.toString(),
      bytesPlanned: job.progress.bytesPlanned?.toString() ?? null,
    },
    error: job.error?.toShape() ?? null,
  };
}

export function createSqliteScanStore(db: Database): ScanStore & { interruptRunning(): void } {
  const put = db.prepare(`
    INSERT INTO scan_jobs (id, state, job_json) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, job_json = excluded.job_json
  `);
  const get = db.prepare<[string], { state: unknown; job_json: string }>("SELECT state, job_json FROM scan_jobs WHERE id = ?");
  const interrupt = db.prepare("UPDATE scan_jobs SET state = 'interrupted' WHERE state = 'running'");
  const prune = db.prepare(`
    DELETE FROM scan_jobs WHERE rowid IN (
      SELECT rowid FROM scan_jobs WHERE state <> 'running' ORDER BY rowid DESC LIMIT -1 OFFSET 256
    )
  `);
  const save = db.transaction((job: ScanJob) => {
    const { state, ...payload } = scanJobView(job);
    put.run(job.id, state, JSON.stringify(payload));
    if (state !== "running") prune.run();
  });
  return {
    save,
    get(id) {
      const row = get.get(id);
      if (!row) return null;
      try {
        const job = ScanJobView.parse({ ...JSON.parse(row.job_json), state: row.state });
        if (job.id !== id) throw new Error("Mismatched scan ID");
        return {
          ...job,
          partial: job.partial || job.state === "interrupted",
          progress: { ...job.progress, bytes: BigInt(job.progress.bytes),
            bytesPlanned: job.progress.bytesPlanned === null ? null : BigInt(job.progress.bytesPlanned) },
          error: job.error && new CommanderError(job.error.code, job.error.message, job.error.retryable),
        };
      } catch {
        throw new CommanderError("internal", "Stored scan is damaged");
      }
    },
    interruptRunning: db.transaction(() => {
      interrupt.run();
      prune.run();
    }),
  };
}
