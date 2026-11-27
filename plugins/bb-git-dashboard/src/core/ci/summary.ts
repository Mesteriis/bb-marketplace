import { isActive, type Run } from "./model.ts";

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

/** How long a run has taken: to now while active, to its last update once finished. */
export function elapsed(run: Run, now: number) {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = isActive(run.state) ? now : run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (hours) return hours + "h " + minutes + "m";
  return minutes ? minutes + "m " + seconds % 60 + "s" : seconds + "s";
}
