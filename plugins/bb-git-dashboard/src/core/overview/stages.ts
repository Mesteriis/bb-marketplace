import type { Run } from "../ci/model.ts";
import type { InboxPr } from "../pulls/model.ts";
import { isReady, isUnpushed, prKey, reasonOf, runAt, runningRuns, unique, type OverviewInput, type OverviewItem, type OverviewKind } from "./items.ts";

/**
 * A card of the board: a pull request, a copy or a run, with the state it shows (its tone and its one action, as the
 * list's row of the same object); null for a pull request that only waits — a draft, or one merged.
 */
export type BoardCard = Omit<OverviewItem, "kind" | "group"> & {kind: OverviewKind | null};
export type OverviewStages = {local: BoardCard[]; open: BoardCard[]; review: BoardCard[]; ready: BoardCard[]; merged: BoardCard[]; ciNow: BoardCard[]};
const day = 24 * 60 * 60 * 1000;
const week = 7 * day;
const repositoryName = (repo: string) => repo.split("/").pop() ?? repo;
const time = (at: string | null) => at ? Date.parse(at) || 0 : 0;

/** The newest finished run of each repository, when it failed within a day. */
function failedLately(runs: OverviewInput["runs"], now: number): {copyId: string; repository: string; run: Run}[] {
  return runs.flatMap(({copyId, repository, runs}) => {
    const done = runs.filter(run => !["running", "queued", "waiting"].includes(run.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return done && done.state === "failure" && now - time(done.updatedAt ?? done.createdAt) <= day ? [{copyId, repository, run: done}] : [];
  });
}

/**
 * The board view: the same objects as the list, by stage — local work (unpushed, never published, or behind origin),
 * open, in review (mine waiting on reviewers, and reviews asked of me), ready to merge, merged this week — and CI now:
 * what runs (copies' runs, my pull requests' CI) and what failed lately. Beyond the list it shows my pull requests that
 * only wait (drafts, ones waiting on others) and the merged ones.
 */
export function overviewStages(input: OverviewInput): OverviewStages {
  const mine = unique(input.mine);
  const mineKeys = new Set(mine.map(prKey));
  // A copy's branch has a pull request when one of mine comes from that branch of the same repository.
  const withPr = new Set(mine.map(pr => repositoryName(pr.repo) + "\n" + pr.headRefName));
  const card = (pr: InboxPr, kind: OverviewKind | null): BoardCard => ({key: prKey(pr), at: pr.mergedAt ?? pr.updatedAt, pr, kind});
  const inReview = (pr: InboxPr) => pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED";
  const local = input.copies.filter(copy => (isUnpushed(copy) || copy.behind > 0) && !(copy.branch && withPr.has(copy.name + "\n" + copy.branch)))
    .map((copy): BoardCard => {
      const kind = isUnpushed(copy) ? "unpushed" : "behind";
      return {key: "copy:" + copy.copyId + (kind === "unpushed" ? ":ahead" : ":behind"), at: copy.at, copyId: copy.copyId, copy, kind};
    });
  const ciNow: BoardCard[] = [
    ...runningRuns(input.runs).map(({copyId, repository, run}): BoardCard => ({key: "run:" + copyId + ":" + run.id, at: runAt(run), copyId, repository, run, kind: "ci-running"})),
    ...failedLately(input.runs, input.now).map(({copyId, repository, run}): BoardCard =>
      ({key: "run:" + copyId + ":" + run.id, at: run.updatedAt ?? run.createdAt, copyId, repository, run, kind: "ci-failed"})),
    ...mine.filter(pr => !pr.isDraft && (pr.ci === "pending" || pr.ci === "failing")).map(pr => card(pr, pr.ci === "pending" ? "ci-running" : "ci-failed")),
  ].map((item, index) => ({item, index})).sort((a, b) => time(b.item.at) - time(a.item.at) || a.index - b.index).map(({item}) => item);
  return {
    local,
    open: mine.filter(pr => !isReady(pr) && !inReview(pr)).map(pr => card(pr, reasonOf(pr))),
    review: [...mine.filter(pr => !isReady(pr) && inReview(pr)).map(pr => card(pr, reasonOf(pr))),
      ...unique(input.requested).filter(pr => !mineKeys.has(prKey(pr))).map(pr => card(pr, "review"))],
    ready: mine.filter(isReady).map(pr => card(pr, "ready")),
    merged: unique(input.merged).filter(pr => pr.mergedAt && input.now - Date.parse(pr.mergedAt) <= week).map(pr => card(pr, null)),
    ciNow,
  };
}
