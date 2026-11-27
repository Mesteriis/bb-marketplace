// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// The forge-neutral pull request row of the inbox and what blocks it. No I/O.

export type CiState = "passing" | "failing" | "pending" | "none";
export type Forge = "github" | "gitlab" | "gitea" | "azure";

export interface FailingCheck {
  name: string;
  /** GitHub Actions workflow (the pipeline) the failing job belongs to. */
  workflow: string | null;
  url: string | null;
}

/** The open PR whose branch this one is based on. */
export interface StackRef {
  number: number;
  title: string;
  url: string;
}

export interface Pr {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  baseRefName: string;
  /** Source branch; lets forges without stack data find the PR below this one. */
  headRefName: string;
  /** False when the PR targets another branch rather than the repo's default. */
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** Null where the forge's list does not say. */
  additions: number | null;
  deletions: number | null;
  ci: CiState;
  failingChecks: FailingCheck[];
  unresolvedThreads: number;
  /** Forge-specific reasons with no common field, e.g. GitLab's "Needs rebase". */
  notes: string[];
  reviewDecision: string | null;
  conflicts: boolean;
  /** Why an open PR is not merged yet; empty means nothing is blocking it. */
  blockers: string[];
  /** Your latest review (Reviewed tab only); stale once the author pushed after it or it was dismissed. */
  myReview: { state: string; stale: boolean } | null;
}


/** A row of the inbox: the PR and the account it was read with. */
export type InboxPr = Pr & {forge: Forge; accountId: string};

export interface PrList {
  total: number;
  items: Pr[];
}


export function blockersOf(pr: Pr): string[] {
  if (pr.mergedAt !== null || pr.closedAt !== null) return [];
  const out: string[] = [];
  if (pr.isDraft) out.push("Draft");
  if (pr.stackedOn) out.push(`Stacked on #${pr.stackedOn.number}`);
  if (pr.conflicts) out.push("Merge conflicts");
  if (pr.ci === "failing") {
    const n = pr.failingChecks.length;
    out.push(n > 0 ? `CI failing (${n} check${n === 1 ? "" : "s"})` : "CI failing");
  }
  if (pr.ci === "pending") out.push("CI running");
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push("Changes requested");
  if (pr.unresolvedThreads > 0) {
    const n = pr.unresolvedThreads;
    out.push(`${n} unresolved comment${n === 1 ? "" : "s"}`);
  }
  out.push(...pr.notes);
  if (pr.reviewDecision === "REVIEW_REQUIRED") out.push("Awaiting review");
  return out;
}

/** Whether a row matches every word of a search, in its title, #number, repo, author, base branch or blockers. */
export function matchesSearch(pr: Pr, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [pr.title, `#${pr.number}`, pr.repo, pr.author, pr.baseRefName, ...pr.blockers].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * Stacks for forges whose list has no stack data: a PR whose base is the source branch of another open PR in the
 * same repository sits on that PR. The default branch is never a parent.
 */
export function linkStacks<T extends Pr>(items: T[]): T[] {
  const heads = new Map<string, StackRef>();
  for (const pr of items) if (pr.mergedAt === null && pr.closedAt === null && pr.headRefName) {
    heads.set(pr.repo + "\u0000" + pr.headRefName, {number: pr.number, title: pr.title, url: pr.url});
  }
  return items.map(pr => {
    if (pr.onDefaultBranch || pr.stackedOn) return pr;
    const stackedOn = heads.get(pr.repo + "\u0000" + pr.baseRefName) ?? null;
    if (!stackedOn || stackedOn.number === pr.number) return pr;
    const next = {...pr, stackedOn};
    return {...next, blockers: blockersOf(next)};
  });
}
