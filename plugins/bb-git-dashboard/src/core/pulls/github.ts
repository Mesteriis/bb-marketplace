// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// GitHub GraphQL shapes and their pure mapping to inbox rows (the query text is in queries.ts). No I/O.
import { blockersOf, type CiState, type FailingCheck, type Pr, type PrList, type StackRef } from "./model.ts";
import type { Watched } from "./watch.ts";

// Loose shape of what the query returns; GitHub omits fields it skipped.
export interface RawContext {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  title?: string | null;
  summary?: string | null;
  checkSuite?: {
    app: { name: string } | null;
    workflowRun: { workflow: { name: string } } | null;
  } | null;
  annotations?: {
    nodes: {
      message: string;
      path: string;
      annotationLevel: string | null;
      location: { start: { line: number } } | null;
    }[];
  };
  startedAt?: string | null;
  context?: string;
  createdAt?: string;
  state?: string;
  description?: string | null;
  targetUrl?: string | null;
}
export interface RawPr {
  id?: string;
  additions?: number;
  deletions?: number;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author?: { login: string } | null;
  baseRefName?: string;
  headRefName?: string;
  repository: { nameWithOwner: string; defaultBranchRef?: { name: string } | null };
  baseRef?: { associatedPullRequests: { nodes: StackRef[] } } | null;
  reviewDecision?: string | null;
  mergeable?: string;
  headRefOid?: string;
  viewerLatestReview?: { state: string; commit?: { oid: string } | null } | null;
  reviewThreads?: { nodes: { isResolved: boolean; comments?: { nodes: { state?: string }[] } }[] };
  commits?: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: RawContext[] };
        } | null;
      };
    }[];
  };
}
export interface RawSearch {
  issueCount: number;
  nodes: (RawPr | Record<string, never>)[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

const FAILED_RUN = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const FAILED_STATUS = new Set(["FAILURE", "ERROR"]);

function ciState(rollup: string | undefined, checks: CheckDetail[]): CiState {
  if (rollup === undefined) return "none";
  // GitHub's rollup counts superseded runs, so judge by the latest runs when we have them.
  if (checks.some((c) => c.status === "failing")) return "failing";
  if (checks.some((c) => c.status === "pending")) return "pending";
  if (checks.length > 0) return "passing";
  if (rollup === "SUCCESS") return "passing";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failing";
  return "pending"; // PENDING, EXPECTED
}

/** Stacked when the base is not the default branch; the parent PR may be gone if its branch was deleted. */
export function stackOf(raw: Pick<RawPr, "baseRefName" | "repository" | "baseRef">): {
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
} {
  // GitHub links the default branch to unrelated PRs, so never treat it as a parent.
  const onDefaultBranch = !raw.baseRefName || raw.baseRefName === raw.repository.defaultBranchRef?.name;
  return { onDefaultBranch, stackedOn: onDefaultBranch ? null : (raw.baseRef?.associatedPullRequests.nodes[0] ?? null) };
}

export function toPr(raw: RawPr): Pr {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks = latestChecks(rollup?.contexts.nodes ?? []);
  const failingChecks: FailingCheck[] = checks
    .filter((c) => c.status === "failing")
    .map(({ name, workflow, url }) => ({ name, workflow, url }));
  const pr: Pr = {
    id: raw.id ?? raw.url,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: raw.repository.nameWithOwner,
    author: raw.author?.login ?? "ghost",
    baseRefName: raw.baseRefName ?? "",
    headRefName: raw.headRefName ?? "",
    ...stackOf(raw),
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    closedAt: raw.closedAt,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    ci: ciState(rollup?.state, checks),
    failingChecks,
    // Threads still in your unsubmitted review are drafts, not open conversations.
    notes: [],
    unresolvedThreads:
      raw.reviewThreads?.nodes.filter((t) => !t.isResolved && t.comments?.nodes[0]?.state !== "PENDING").length ?? 0,
    reviewDecision: raw.reviewDecision ?? null,
    // UNKNOWN means GitHub has not computed it yet; only CONFLICTING is a conflict.
    conflicts: raw.mergeable === "CONFLICTING",
    blockers: [],
    myReview: raw.viewerLatestReview
      ? {
          state: raw.viewerLatestReview.state,
          stale:
            raw.viewerLatestReview.state === "DISMISSED" ||
            (!!raw.headRefOid && raw.viewerLatestReview.commit?.oid !== raw.headRefOid),
        }
      : null,
  };
  pr.blockers = blockersOf(pr);
  return pr;
}


export function toList(search: RawSearch): PrList {
  return {
    total: search.issueCount,
    // Search can return non-PR nodes as {} when the fragment does not match.
    items: search.nodes.filter((n): n is RawPr => "url" in n).map(toPr),
  };
}

// ---- CI checks (shared by the list and the detail view) ----

export type CheckStatus = "failing" | "pending" | "passing" | "skipped";

export interface Annotation {
  path: string;
  line: number | null;
  level: string | null;
  message: string;
}

export interface CheckDetail {
  /** Job name for GitHub Actions, context name for commit statuses. */
  name: string;
  /** The pipeline: the Actions workflow, else the CI app (e.g. Jenkins). */
  workflow: string | null;
  status: CheckStatus;
  conclusion: string | null;
  url: string | null;
  title: string | null;
  summary: string | null;
  annotations: Annotation[];
}

export function checkOf(c: RawContext): CheckDetail {
  if (c.__typename === "StatusContext") {
    const state = c.state ?? "";
    return {
      name: c.context ?? "status",
      workflow: null,
      status: FAILED_STATUS.has(state) ? "failing" : state === "SUCCESS" ? "passing" : "pending",
      conclusion: state || null,
      url: c.targetUrl ?? null,
      title: c.description ?? null,
      summary: null,
      annotations: [],
    };
  }
  const conclusion = c.conclusion ?? null;
  const status: CheckStatus = FAILED_RUN.has(conclusion ?? "")
    ? "failing"
    : c.status !== undefined && c.status !== "COMPLETED"
      ? "pending"
      : conclusion === "SUCCESS"
        ? "passing"
        : "skipped"; // SKIPPED, NEUTRAL, STALE
  return {
    name: c.name ?? "check",
    workflow:
      c.checkSuite?.workflowRun?.workflow.name ?? c.checkSuite?.app?.name ?? null,
    status,
    conclusion,
    url: c.detailsUrl ?? null,
    title: c.title || null,
    summary: c.summary || null,
    annotations: (c.annotations?.nodes ?? []).map((a) => ({
      path: a.path,
      line: a.location?.start.line ?? null,
      level: a.annotationLevel,
      message: a.message,
    })),
  };
}

/**
 * One check per pipeline job: the commit keeps every run of a job (re-runs,
 * runs cancelled by a newer one), and only the latest decides, as in branch
 * protection.
 */
export function latestChecks(contexts: RawContext[]): CheckDetail[] {
  const latest = new Map<string, { at: string; check: CheckDetail }>();
  for (const c of contexts) {
    const check = checkOf(c);
    const key = `${check.workflow ?? ""}|${check.name}`;
    const at = c.startedAt ?? c.createdAt ?? "";
    if ((latest.get(key)?.at ?? "") <= at) latest.set(key, { at, check });
  }
  return [...latest.values()].map((v) => v.check);
}

// ---- Watcher: one account's open PRs ----

interface RawWho {
  author: { __typename?: string; login: string } | null;
  createdAt?: string;
  submittedAt?: string | null;
  url: string;
}
export interface RawWatchPr {
  id: string;
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  comments: { nodes: RawWho[] };
  reviews: { nodes: RawWho[] };
  reviewThreads: { nodes: { comments: { nodes: RawWho[] } }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}

export function toWatched(raw: RawWatchPr, ignore: Set<string>): Watched {
  const me = raw.author?.login;
  const contexts = raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const candidates = [
    ...raw.comments.nodes,
    ...raw.reviews.nodes,
    ...raw.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
  ].flatMap((w) => {
    const at = w.createdAt ?? w.submittedAt;
    const who = w.author;
    if (!who || !at || who.login === me || who.__typename === "Bot" || ignore.has(who.login.toLowerCase())) return [];
    return [{ author: who.login, at, url: w.url }];
  });
  return {
    id: raw.id,
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    failing: latestChecks(contexts)
      .filter((c) => c.status === "failing")
      .map((c) => (c.workflow ? `${c.workflow} › ${c.name}` : c.name)),
    lastComment: candidates.reduce<Watched["lastComment"]>((a, b) => (a && a.at >= b.at ? a : b), null),
  };
}
