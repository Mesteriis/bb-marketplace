import type { Run } from "./model.ts";

const keep = 200;
/**
 * Identifies one failure. Attempt and update time are both part of it: Azure retries a build under the same id
 * and attempt, so only the new finish time tells a second failure from the first.
 */
export const failureKey = (run: Run) => run.id + "#" + run.attempt + "#" + (run.updatedAt ?? "");

/**
 * Failed runs not reported before. `seen` is null on the first look, which only records what already failed so that
 * subscribing does not replay history. Callers store `seen` only for failures they actually delivered.
 */
export function newFailures(seen: string[] | null, runs: Run[]) {
  const known = new Set(seen ?? []);
  const failed = runs.filter(run => run.state === "failure" && !known.has(failureKey(run)));
  const next = [...failed.map(failureKey), ...(seen ?? [])];
  return {failed: seen === null ? [] : failed, seen: [...new Set(next)].slice(0, keep)};
}
