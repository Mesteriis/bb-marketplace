import type { ReviewRun } from "../../core/code-review/model.ts";

/** What a run does, as its row in the review names it. */
export function runTitle(run: Pick<ReviewRun, "kind" | "focus">): string {
  if (run.kind === "review") return run.focus === null ? "AI review" : "AI review · " + run.focus;
  if (run.kind === "fix") return "Fixes in a new thread";
  if (run.kind === "summary") return "Summary";
  return run.focus === null ? "Explanation" : "Explain · " + run.focus;
}
export const runStatusLabel: Record<ReviewRun["status"], string> = {running: "Running", done: "Done", failed: "Failed", closed: "Closed"};
