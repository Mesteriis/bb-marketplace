import type { Run } from "./model.ts";

const keep = 200;
const keyOf = (run: Run) => run.id + "#" + run.attempt;

/**
 * Failed runs not reported before. `seen` is null on the first look, which only records what already failed so that
 * subscribing does not replay history.
 */
export function newFailures(seen: string[] | null, runs: Run[]) {
  const known = new Set(seen ?? []);
  const failed = runs.filter(run => run.state === "failure" && !known.has(keyOf(run)));
  const next = [...failed.map(keyOf), ...(seen ?? [])];
  return {failed: seen === null ? [] : failed, seen: [...new Set(next)].slice(0, keep)};
}
