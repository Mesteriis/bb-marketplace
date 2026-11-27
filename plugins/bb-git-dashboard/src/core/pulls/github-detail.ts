// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// GitHub's GraphQL pull request detail and its mapping. No I/O.
import { latestChecks, stackOf, type CheckStatus, type RawContext } from "./github.ts";
import type { Comment, PrDetail, Reviewer, Thread, TimelineEntry } from "./detail.ts";
import type { StackRef } from "./model.ts";

const ROLLUP: Record<string, CheckStatus> = {
  SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending",
};

type RawAuthor = { login: string; avatarUrl?: string } | null;
interface RawComment {
  id?: string;
  viewerCanDelete?: boolean;
  author: RawAuthor;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string;
  state?: string;
}
export interface RawDetail {
  id?: string;
  pendingReview?: { nodes: { id: string }[] };
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  baseRef?: { associatedPullRequests: { nodes: StackRef[] } } | null;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: string;
  createdAt: string;
  body: string;
  author: RawAuthor;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  headRefOid?: string;
  repository: { nameWithOwner: string; defaultBranchRef?: { name: string } | null };
  reviewThreads: {
    nodes: {
      id?: string;
      diffSide?: string;
      startLine?: number | null;
      isResolved: boolean;
      isOutdated: boolean;
      viewerCanResolve?: boolean;
      viewerCanUnresolve?: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      resolvedBy: RawAuthor;
      comments: { nodes: RawComment[] };
    }[];
  };
  comments: { nodes: RawComment[] };
  reviews: {
    nodes: {
      author: RawAuthor;
      state: string;
      body: string;
      submittedAt: string | null;
      url: string;
    }[];
  };
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[];
  };
  viewerLatestReview?: { commit: { oid: string } | null } | null;
  viewerCanUpdate?: boolean;
  labels?: { nodes: { name: string; color: string }[] };
  latestReviews?: { nodes: { author: RawAuthor; state: string }[] };
  reviewRequests?: {
    nodes: {
      requestedReviewer: { __typename: string; login?: string; name?: string; avatarUrl?: string | null } | null;
    }[];
  };
  history?: {
    totalCount: number;
    nodes: {
      commit: {
        oid: string;
        abbreviatedOid: string;
        messageHeadline: string;
        committedDate: string;
        statusCheckRollup: { state: string } | null;
        author: { name: string | null; avatarUrl?: string | null; user: { login: string } | null } | null;
      };
    }[];
  };
}

const login = (a: RawAuthor) => a?.login ?? "ghost";
const comment = (c: RawComment): Comment => ({
  id: c.id ?? "",
  canDelete: c.viewerCanDelete ?? false,
  author: login(c.author),
  avatarUrl: c.author?.avatarUrl ?? null,
  body: c.body,
  createdAt: c.createdAt,
  url: c.url,
});
const CHECK_ORDER: Record<CheckStatus, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 };

export function reviewersOf(raw: RawDetail, author: string): Reviewer[] {
  const requested: Reviewer[] = (raw.reviewRequests?.nodes ?? []).flatMap(({ requestedReviewer: r }) => {
    const name = r?.login ?? r?.name;
    return name ? [{ name, avatarUrl: r?.avatarUrl ?? null, team: r?.__typename === "Team", state: "REQUESTED" }] : [];
  });
  const asked = new Set(requested.map((r) => r.name));
  const reviewed: Reviewer[] = (raw.latestReviews?.nodes ?? [])
    .filter((r) => r.author && r.author.login !== author && !asked.has(r.author.login))
    .map((r) => ({ name: r.author!.login, avatarUrl: r.author!.avatarUrl ?? null, team: false, state: r.state }));
  return [...requested, ...reviewed];
}

export function toDetail(raw: RawDetail, viewer = ""): PrDetail {
  const author = login(raw.author);
  const threads: Thread[] = raw.reviewThreads.nodes.map((t) => {
    const comments = t.comments.nodes.map(comment);
    const hunk = t.comments.nodes[0]?.diffHunk;
    return {
      id: t.id ?? "",
      path: t.path,
      side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      startLine: t.startLine ?? null,
      isPending: t.comments.nodes[0]?.state === "PENDING",
      line: t.line ?? t.originalLine,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      resolvedBy: t.resolvedBy ? login(t.resolvedBy) : null,
      canToggleResolved: !!(t.isResolved ? t.viewerCanUnresolve : t.viewerCanResolve),
      diffHunk: hunk ? hunk.split("\n").slice(-8).join("\n") : null,
      comments,
      awaitingReply: !t.isResolved && comments.at(-1)?.author !== author,
    };
  });
  const timeline: TimelineEntry[] = [
    ...(raw.body.trim() === ""
      ? []
      : [{ ...comment(raw), id: "", canDelete: false, reviewState: null }]),
    ...raw.comments.nodes.map((c) => ({ ...comment(c), reviewState: null })),
    ...raw.reviews.nodes
      // A bare COMMENTED review only wraps thread comments, shown under threads.
      .filter((r) => r.submittedAt !== null && (r.body.trim() !== "" || r.state !== "COMMENTED"))
      .map((r) => ({
        id: "",
        canDelete: false,
        author: login(r.author),
        avatarUrl: r.author?.avatarUrl ?? null,
        body: r.body,
        createdAt: r.submittedAt!,
        url: r.url,
        reviewState: r.state,
      })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const contexts = raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    forge: "github",
    id: raw.id ?? "",
    headSha: raw.headRefOid ?? null,
    viewer,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    repo: raw.repository.nameWithOwner,
    author,
    authorAvatarUrl: raw.author?.avatarUrl ?? null,
    state: raw.state,
    isDraft: raw.isDraft,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    ...stackOf(raw),
    changedFiles: raw.changedFiles ?? 0,
    pendingReviewId: raw.pendingReview?.nodes[0]?.id ?? null,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    reviewDecision: raw.reviewDecision,
    conflicts: raw.mergeable === "CONFLICTING",
    timeline,
    // Array sort is stable, so GitHub's order survives within each group.
    threads: threads.sort((a, b) => Number(a.isResolved) - Number(b.isResolved)),
    checks: latestChecks(contexts).sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]),
    commits: (raw.history?.nodes ?? [])
      .map(({ commit: c }) => ({
        oid: c.oid,
        shortOid: c.abbreviatedOid,
        headline: c.messageHeadline,
        author: c.author?.user?.login ?? c.author?.name ?? "unknown",
        avatarUrl: c.author?.avatarUrl ?? null,
        committedDate: c.committedDate,
        ci: c.statusCheckRollup ? (ROLLUP[c.statusCheckRollup.state] ?? null) : null,
      }))
      .reverse(),
    commitCount: raw.history?.totalCount ?? 0,
    reviewers: reviewersOf(raw, author),
    labels: (raw.labels?.nodes ?? []).map((l) => ({ name: l.name, color: /^[0-9a-f]{6}$/i.test(l.color) ? l.color : null })),
    body: raw.body,
    canEdit: raw.viewerCanUpdate ?? false,
    myReviewOid: raw.viewerLatestReview?.commit?.oid ?? null,
  };
}

