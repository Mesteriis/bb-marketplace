import type { MessageKey } from "../../core/i18n/dictionary.ts";
import type { ReviewRun } from "../../core/code-review/model.ts";

/** What a run does, as its row in the review names it: a dictionary key and its values. */
export function runTitle(run: Pick<ReviewRun, "kind" | "focus">): {key: MessageKey; values: Record<string, string>} {
  if (run.kind === "review") return run.focus === null ? {key: "ai.t.review", values: {}} : {key: "ai.t.review-on", values: {focus: run.focus}};
  if (run.kind === "fix") return {key: "ai.t.fix", values: {}};
  if (run.kind === "summary") return {key: "ai.t.summary", values: {}};
  return run.focus === null ? {key: "ai.t.explain", values: {}} : {key: "ai.t.explain-on", values: {focus: run.focus}};
}
export const runStatusLabel: Record<ReviewRun["status"], MessageKey> = {running: "ai.s.running", done: "ai.s.done", failed: "ai.s.failed", closed: "ai.s.closed"};
