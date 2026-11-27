import type { Run } from "../ci/model.ts";
import type { InboxPr } from "../pulls/model.ts";

/** What the overview knows of an attached copy: its branch and how far it is from its upstream (git status, no fetch). */
export type CopyState = {copyId: string; name: string; branch: string | null; ahead: number; behind: number; at: string | null};
export type RepositoryRuns = {copyId: string; repository: string; runs: Run[]};
export type OverviewInput = {
  /** My open pull requests (My PRs, Open). */
  mine: InboxPr[];
  /** Pull requests waiting for my review (My PRs, Review requested). */
  requested: InboxPr[];
  /** My merged pull requests (My PRs, Merged). */
  merged: InboxPr[];
  runs: RepositoryRuns[];
  copies: CopyState[];
  now: number;
};
export type OverviewKind = "ci-failed" | "review" | "conflict" | "threads" | "ready" | "unpushed" | "ci-running" | "behind";
export type OverviewGroup = "action" | "finish" | "waiting";
export type OverviewItem = {key: string; kind: OverviewKind; group: OverviewGroup; at: string | null;
  pr?: InboxPr; copyId?: string; copy?: CopyState; repository?: string; run?: Run};

export const groupOf: Record<OverviewKind, OverviewGroup> = {
  "ci-failed": "action", review: "action", conflict: "action", threads: "action",
  ready: "finish", unpushed: "finish", "ci-running": "waiting", behind: "waiting",
};
const groups: OverviewGroup[] = ["action", "finish", "waiting"];
const prKey = (pr: InboxPr) => "pr:" + pr.accountId + ":" + pr.repo + "#" + pr.number;

/** Open, not a draft, nothing blocking it and CI green or absent: one merge away. */
export const isReady = (pr: InboxPr) => !pr.isDraft && pr.blockers.length === 0 && (pr.ci === "passing" || pr.ci === "none");

/** The reason one of my open pull requests needs something, most pressing first; null when it only waits. */
function reasonOf(pr: InboxPr): OverviewKind | null {
  if (pr.ci === "failing") return "ci-failed";
  if (pr.conflicts) return "conflict";
  if (pr.unresolvedThreads > 0) return "threads";
  return isReady(pr) ? "ready" : null;
}

/** The newest run that has not finished, of each repository. */
export function runningRuns(runs: RepositoryRuns[]): {copyId: string; repository: string; run: Run}[] {
  return runs.flatMap(({copyId, repository, runs}) => {
    const open = runs.filter(run => run.state === "running" || run.state === "queued" || run.state === "waiting")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0] ? [{copyId, repository, run: open[0]}] : [];
  });
}

/** The list view of the overview: what needs me, what I can finish, what goes on without me. */
export function overviewItems(input: OverviewInput): OverviewItem[] {
  const items: OverviewItem[] = [];
  const add = (kind: OverviewKind, item: Omit<OverviewItem, "kind" | "group">) => items.push({...item, kind, group: groupOf[kind]});
  const mine = new Set(input.mine.map(prKey));
  for (const pr of input.mine) {
    const kind = reasonOf(pr);
    if (kind) add(kind, {key: prKey(pr), at: pr.updatedAt, pr});
  }
  for (const pr of input.requested) if (!mine.has(prKey(pr))) add("review", {key: prKey(pr), at: pr.updatedAt, pr});
  for (const copy of input.copies) if (copy.ahead > 0) add("unpushed", {key: "copy:" + copy.copyId + ":ahead", at: copy.at, copyId: copy.copyId, copy});
  for (const {copyId, repository, run} of runningRuns(input.runs)) {
    add("ci-running", {key: "run:" + copyId + ":" + run.id, at: run.startedAt ?? run.createdAt, copyId, repository, run});
  }
  for (const copy of input.copies) if (copy.behind > 0) add("behind", {key: "copy:" + copy.copyId + ":behind", at: copy.at, copyId: copy.copyId, copy});
  const time = (item: OverviewItem) => item.at ? Date.parse(item.at) || 0 : 0;
  return groups.flatMap(group => items.filter(item => item.group === group)
    .map((item, index) => ({item, index})).sort((a, b) => time(b.item) - time(a.item) || a.index - b.index).map(({item}) => item));
}
