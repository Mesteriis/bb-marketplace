/** What the Git panel beside a thread sums up of a working copy: its pull request, its CI and the error lines. No I/O. */
import type { Run } from "../ci/model.ts";
import { runAt } from "../overview/items.ts";
import { sameRepository } from "../projects/table.ts";
import type { InboxPr } from "../pulls/model.ts";

/** The open pull request from the copy's branch in the copy's repository; null without a branch or a repository. */
export function branchPull(mine: readonly InboxPr[], branch: string | null, repository: string | null): InboxPr | null {
  if (branch === null || repository === null) return null;
  return mine.find(item => item.headRefName === branch && sameRepository(repository, item.repo)) ?? null;
}

/** The newest run on the copy's own branch: another branch's run is not this copy's. */
export function branchRun(runs: readonly Run[], branch: string | null): Run | null {
  if (branch === null) return null;
  return runs.filter(run => run.branch === branch).reduce<Run | null>((newest, run) => !newest || runAt(run) > runAt(newest) ? run : newest, null);
}

/** The error line of a log (0-based `at`) and the line after it, numbered from 1 as the log shows them. */
export function errorLines(lines: readonly string[], at: number | null): {number: number; text: string}[] {
  if (at === null) return [];
  return lines.slice(at, at + 2).map((text, index) => ({number: at + index + 1, text}));
}

export type PrChip = {key: "draft" | "conflict" | "ci-failed" | "ci-running" | "ci-passed" | "changes" | "approved" | "review-waiting" | "unanswered" | "no-conflicts";
  tone: "bad" | "warn" | "good" | "line"; n?: number};

/** A pull request's state as chips: draft, conflicts, CI, review, unanswered threads — in words, the worst first. */
export function prState(pr: InboxPr): PrChip[] {
  const chips: PrChip[] = [];
  if (pr.isDraft) chips.push({key: "draft", tone: "line"});
  if (pr.conflicts) chips.push({key: "conflict", tone: "warn"});
  if (pr.ci === "failing") chips.push({key: "ci-failed", tone: "bad"});
  else if (pr.ci === "pending") chips.push({key: "ci-running", tone: "warn"});
  else if (pr.ci === "passing") chips.push({key: "ci-passed", tone: "good"});
  if (pr.reviewDecision === "CHANGES_REQUESTED") chips.push({key: "changes", tone: "bad"});
  else if (pr.reviewDecision === "APPROVED") chips.push({key: "approved", tone: "good"});
  else if (pr.reviewDecision === "REVIEW_REQUIRED") chips.push({key: "review-waiting", tone: "line"});
  if (pr.unresolvedThreads > 0) chips.push({key: "unanswered", tone: "line", n: pr.unresolvedThreads});
  if (!pr.conflicts) chips.push({key: "no-conflicts", tone: "line"});
  return chips;
}
