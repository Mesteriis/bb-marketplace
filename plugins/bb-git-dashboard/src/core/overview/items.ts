import type { Run } from "../ci/model.ts";
import type { InboxPr } from "../pulls/model.ts";

/** What the overview knows of an attached copy, from git status without a fetch: its branch, upstream and distance to it. */
export type CopyState = {copyId: string; name: string; branch: string | null; upstream: string | null; ahead: number; behind: number; files: number; at: string | null};
/** A repository's runs, read for one of its copies; `forge` is the kind of forge it is on, when known. */
export type RepositoryRuns = {copyId: string; repository: string; runs: Run[]; forge?: string};
export type OverviewInput = {
  /** My open pull requests (My PRs, Open). */
  mine: InboxPr[];
  /** Pull requests waiting for my review (My PRs, Review requested). */
  requested: InboxPr[];
  /** My merged pull requests (My PRs, Merged), for the board. */
  merged: InboxPr[];
  runs: RepositoryRuns[];
  copies: CopyState[];
  now: number;
};
export type OverviewKind = "ci-failed" | "review" | "conflict" | "changes" | "threads" | "ready" | "unpushed" | "ci-running" | "behind";
export type OverviewGroup = "action" | "finish" | "waiting";
export type OverviewItem = {key: string; kind: OverviewKind; group: OverviewGroup; at: string | null;
  pr?: InboxPr; copyId?: string; copy?: CopyState; repository?: string; run?: Run};
/** One thing keeping a pull request from merging, as a word of the interface (forge-specific notes keep their text). */
export type Blocker = {key: "draft" | "stacked" | "conflicts" | "ci-failing" | "ci-running" | "changes" | "threads" | "review-required"; n?: number}
  | {key: "note"; text: string};

export const groupOf: Record<OverviewKind, OverviewGroup> = {
  "ci-failed": "action", review: "action", conflict: "action", changes: "action", threads: "action",
  ready: "finish", unpushed: "finish", "ci-running": "waiting", behind: "waiting",
};
const groups: OverviewGroup[] = ["action", "finish", "waiting"];
/** A pull request is the same one whichever account read it. */
export const prKey = (pr: InboxPr) => "pr:" + pr.url;

/** What keeps a pull request from merging, from its fields, in the order My PRs lists them. */
export function blockerList(pr: InboxPr): Blocker[] {
  const out: Blocker[] = [];
  if (pr.isDraft) out.push({key: "draft"});
  if (pr.stackedOn) out.push({key: "stacked", n: pr.stackedOn.number});
  if (pr.conflicts) out.push({key: "conflicts"});
  if (pr.ci === "failing") out.push({key: "ci-failing", n: pr.failingChecks.length});
  if (pr.ci === "pending") out.push({key: "ci-running"});
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push({key: "changes"});
  if (pr.unresolvedThreads > 0) out.push({key: "threads", n: pr.unresolvedThreads});
  for (const text of pr.notes) out.push({key: "note", text});
  if (pr.reviewDecision === "REVIEW_REQUIRED") out.push({key: "review-required"});
  return out;
}

/**
 * One merge away, on the forge's word: CI green, an approval or no review required, nothing blocking. A forge that does
 * not say (Gitea gives no review decision, Azure no CI state) is not taken as a yes.
 */
/** What a blocker is: something failed, something to wait for, or something for someone to do. */
export function blockerSense(blocker: Blocker): "failed" | "waiting" | "todo" {
  switch (blocker.key) {
    case "ci-failing": case "conflicts": return "failed";
    case "ci-running": case "review-required": case "draft": case "stacked": return "waiting";
    default: return "todo";
  }
}
export const isReady = (pr: InboxPr) => !pr.isDraft && pr.blockers.length === 0 && pr.ci === "passing" && pr.reviewDecision === "APPROVED";

/** The reason one of my open pull requests is in the list, most pressing first; null when it only waits (a draft). */
export function reasonOf(pr: InboxPr): OverviewKind | null {
  if (pr.ci === "failing") return "ci-failed";
  if (pr.conflicts) return "conflict";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (pr.unresolvedThreads > 0) return "threads";
  if (isReady(pr)) return "ready";
  if (pr.ci === "pending" && !pr.isDraft) return "ci-running";
  return null;
}

/** Work only this machine has: commits ahead of the upstream, or a branch never published. */
export const isUnpushed = (copy: Pick<CopyState, "ahead" | "branch" | "upstream">) => copy.ahead > 0 || (copy.branch !== null && copy.upstream === null);

/** The newest run that has not finished, of each repository. */
export function runningRuns(runs: RepositoryRuns[]): {copyId: string; repository: string; run: Run}[] {
  return runs.flatMap(({copyId, repository, runs}) => {
    const open = runs.filter(run => run.state === "running" || run.state === "queued" || run.state === "waiting")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0] ? [{copyId, repository, run: open[0]}] : [];
  });
}
export const runAt = (run: Run) => run.startedAt ?? run.createdAt;

/** Each pull request once, by its address. */
export function unique(prs: InboxPr[]): InboxPr[] {
  const seen = new Set<string>();
  return prs.filter(pr => !seen.has(prKey(pr)) && Boolean(seen.add(prKey(pr))));
}

/** The list view of the overview: what needs me, what I can finish, what goes on without me. */
export function overviewItems(input: OverviewInput): OverviewItem[] {
  const items: OverviewItem[] = [];
  const add = (kind: OverviewKind, item: Omit<OverviewItem, "kind" | "group">) => items.push({...item, kind, group: groupOf[kind]});
  const mine = unique(input.mine);
  const mineKeys = new Set(mine.map(prKey));
  for (const pr of mine) {
    const kind = reasonOf(pr);
    if (kind) add(kind, {key: prKey(pr), at: pr.updatedAt, pr});
  }
  for (const pr of unique(input.requested)) if (!mineKeys.has(prKey(pr))) add("review", {key: prKey(pr), at: pr.updatedAt, pr});
  for (const copy of input.copies) if (isUnpushed(copy)) add("unpushed", {key: "copy:" + copy.copyId + ":ahead", at: copy.at, copyId: copy.copyId, copy});
  for (const {copyId, repository, run} of runningRuns(input.runs)) add("ci-running", {key: "run:" + copyId + ":" + run.id, at: runAt(run), copyId, repository, run});
  for (const copy of input.copies) if (copy.behind > 0) add("behind", {key: "copy:" + copy.copyId + ":behind", at: copy.at, copyId: copy.copyId, copy});
  const time = (item: OverviewItem) => item.at ? Date.parse(item.at) || 0 : 0;
  return groups.flatMap(group => items.filter(item => item.group === group)
    .map((item, index) => ({item, index})).sort((a, b) => time(b.item) - time(a.item) || a.index - b.index).map(({item}) => item));
}
