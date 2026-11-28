import { isActive, type Job, type Run } from "./model.ts";
import { duration } from "../i18n/time.ts";

/** The tiles above a list of runs: what runs, what waits, what failed, and how often finished runs succeed. */
export function ciSummary(runs: Run[]) {
  const finished = runs.filter(run => run.state === "success" || run.state === "failure");
  const succeeded = finished.filter(run => run.state === "success").length;
  return {
    running: runs.filter(run => run.state === "running").length,
    queued: runs.filter(run => run.state === "queued" || run.state === "waiting").length,
    failed: runs.filter(run => run.state === "failure").length,
    successRate: finished.length ? Math.round(succeeded / finished.length * 100) : null,
    total: runs.length,
  };
}

/** Seconds a run has taken: to now while active, to its last update once finished; null when either end is unknown. */
export function runSeconds(run: Run, now: number): number | null {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = isActive(run.state) ? now : run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** Seconds a job has taken: from its start to its end, or to now while it runs; null before it starts. */
export function jobSeconds(job: Job, now: number): number | null {
  const start = Date.parse(job.startedAt ?? "");
  const end = job.completedAt ? Date.parse(job.completedAt) : isActive(job.state) ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** How long a run has taken, in English short form ("1h 2m"), for the command line. */
export function elapsed(run: Run, now: number) {
  const seconds = runSeconds(run, now);
  return seconds === null ? null : duration("en", seconds);
}
