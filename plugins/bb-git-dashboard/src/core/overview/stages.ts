import { isReady, runningRuns, type OverviewInput, type OverviewItem } from "./items.ts";

/** A card of the board: a pull request, a copy or a run. */
export type BoardCard = Omit<OverviewItem, "kind" | "group">;
export type OverviewStages = {local: BoardCard[]; open: BoardCard[]; review: BoardCard[]; ready: BoardCard[]; merged: BoardCard[]; ciNow: BoardCard[]};
const week = 7 * 24 * 60 * 60 * 1000;

/**
 * The board view: the same objects by stage — local work without a pull request, open, in review, ready to merge,
 * merged this week — and the runs going on now.
 */
export function overviewStages(input: OverviewInput): OverviewStages {
  const withPr = new Set(input.mine.map(pr => pr.headRefName));
  const prItem = (pr: OverviewInput["mine"][number]): BoardCard => ({key: "pr:" + pr.accountId + ":" + pr.repo + "#" + pr.number, at: pr.mergedAt ?? pr.updatedAt, pr});
  const inReview = (pr: OverviewInput["mine"][number]) => pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED";
  return {
    local: input.copies.filter(copy => copy.ahead > 0 && !(copy.branch && withPr.has(copy.branch)))
      .map(copy => ({key: "copy:" + copy.copyId + ":ahead", at: copy.at, copyId: copy.copyId, copy})),
    open: input.mine.filter(pr => !isReady(pr) && !inReview(pr)).map(prItem),
    review: input.mine.filter(pr => !isReady(pr) && inReview(pr)).map(prItem),
    ready: input.mine.filter(isReady).map(prItem),
    merged: input.merged.filter(pr => pr.mergedAt && input.now - Date.parse(pr.mergedAt) <= week).map(prItem),
    ciNow: runningRuns(input.runs).map(({copyId, repository, run}) => ({key: "run:" + copyId + ":" + run.id, at: run.createdAt, copyId, repository, run})),
  };
}
