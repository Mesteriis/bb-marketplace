// What keeps a pull request from merging, from the detail its page reads: one line per condition and its sense. No I/O.
import type { PrDetail } from "./detail.ts";

export type Sense = "failed" | "waiting" | "todo" | "ok";
export type MergeLine =
  | {key: "ci"; sense: Sense; failing: string | null; passed: number; total: number}
  | {key: "review"; sense: Sense; approvals: number; unanswered: number}
  | {key: "conflicts"; sense: Sense; base: string}
  | {key: "draft"; sense: Sense}
  | {key: "stacked"; sense: Sense; n: number};

type Input = Pick<PrDetail, "checks" | "reviewers" | "reviewDecision" | "conflicts" | "threads" | "isDraft" | "stackedOn" | "baseRefName">;

/**
 * CI (the first failing check, how many passed of how many), review (approvals, comments waiting for an answer),
 * conflicts with the base, then a draft or a pull request stacked on another. No checks and no review asked: no line.
 */
export function mergeLines(detail: Input): MergeLine[] {
  const out: MergeLine[] = [];
  const counted = detail.checks.filter(check => check.status !== "skipped");
  if (counted.length) {
    const failing = counted.find(check => check.status === "failing")?.name ?? null;
    const pending = counted.some(check => check.status === "pending");
    out.push({key: "ci", sense: failing ? "failed" : pending ? "waiting" : "ok", failing, passed: counted.filter(check => check.status === "passing").length,
      total: counted.length});
  }
  const approvals = detail.reviewers.filter(reviewer => reviewer.state === "APPROVED").length;
  const unanswered = detail.threads.filter(thread => !thread.isResolved && !thread.isPending && thread.awaitingReply).length;
  if (detail.reviewDecision || detail.reviewers.length || unanswered) {
    const sense: Sense = detail.reviewDecision === "CHANGES_REQUESTED" ? "todo" : detail.reviewDecision === "APPROVED" && !unanswered ? "ok"
      : detail.reviewDecision === "REVIEW_REQUIRED" || detail.reviewers.some(reviewer => reviewer.state === "REQUESTED") ? "waiting" : unanswered ? "todo" : "ok";
    out.push({key: "review", sense, approvals, unanswered});
  }
  out.push({key: "conflicts", sense: detail.conflicts ? "failed" : "ok", base: detail.baseRefName});
  if (detail.isDraft) out.push({key: "draft", sense: "waiting"});
  if (detail.stackedOn) out.push({key: "stacked", sense: "waiting", n: detail.stackedOn.number});
  return out;
}
