import { isReady, isUnpushed, prKey, runAt, runningRuns, unique, type OverviewInput, type OverviewItem } from "./items.ts";

/** A card of the board: a pull request, a copy or a run. */
export type BoardCard = Omit<OverviewItem, "kind" | "group">;
export type OverviewStages = {local: BoardCard[]; open: BoardCard[]; review: BoardCard[]; ready: BoardCard[]; merged: BoardCard[]; ciNow: BoardCard[]};
const week = 7 * 24 * 60 * 60 * 1000;
const repositoryName = (repo: string) => repo.split("/").pop() ?? repo;

/**
 * The board view: the same objects by stage — local work without a pull request, open, in review, ready to merge,
 * merged this week — and the runs going on now.
 */
export function overviewStages(input: OverviewInput): OverviewStages {
  const mine = unique(input.mine);
  // A copy's branch has a pull request when one of mine comes from that branch of the same repository.
  const withPr = new Set(mine.map(pr => repositoryName(pr.repo) + "\n" + pr.headRefName));
  const card = (pr: OverviewInput["mine"][number]): BoardCard => ({key: prKey(pr), at: pr.mergedAt ?? pr.updatedAt, pr});
  const inReview = (pr: OverviewInput["mine"][number]) => pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED";
  return {
    local: input.copies.filter(copy => isUnpushed(copy) && !(copy.branch && withPr.has(copy.name + "\n" + copy.branch)))
      .map(copy => ({key: "copy:" + copy.copyId + ":ahead", at: copy.at, copyId: copy.copyId, copy})),
    open: mine.filter(pr => !isReady(pr) && !inReview(pr)).map(card),
    review: mine.filter(pr => !isReady(pr) && inReview(pr)).map(card),
    ready: mine.filter(isReady).map(card),
    merged: unique(input.merged).filter(pr => pr.mergedAt && input.now - Date.parse(pr.mergedAt) <= week).map(card),
    ciNow: runningRuns(input.runs).map(({copyId, repository, run}) => ({key: "run:" + copyId + ":" + run.id, at: runAt(run), copyId, repository, run})),
  };
}
