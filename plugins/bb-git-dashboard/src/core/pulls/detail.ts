// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// The pull request detail view, forge-neutral: description and discussion, line threads, checks, commits. No I/O.
import type { CheckDetail, CheckStatus } from "./github.ts";
import type { Forge, StackRef } from "./model.ts";

export interface Comment {
  /** GraphQL node id, used to delete; empty for a review summary or the description. */
  id: string;
  /** GitHub lets the viewer delete it: in practice, your own comments. */
  canDelete: boolean;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface Thread {
  /** The forge's id of the thread (GitHub GraphQL node, GitLab discussion, Azure thread), used to reply and resolve. */
  id: string;
  path: string;
  /** Which side of the diff the line number refers to. */
  side: "LEFT" | "RIGHT";
  /** First line of a multi-line comment; null for a single line. */
  startLine: number | null;
  /** Part of your unsubmitted review: only you can see it. */
  isPending: boolean;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  /** GitHub lets the viewer resolve it (or unresolve it, once resolved). */
  canToggleResolved: boolean;
  /** Last lines of the diff the thread is attached to. */
  diffHunk: string | null;
  comments: Comment[];
  /** Unresolved and the last word is not the PR author's. */
  awaitingReply: boolean;
}

export interface TimelineEntry extends Comment {
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED; null for a plain comment. */
  reviewState: string | null;
}

export interface PrCommit {
  oid: string;
  shortOid: string;
  headline: string;
  author: string;
  avatarUrl: string | null;
  committedDate: string;
  /** The commit's CI rollup; null when it ran none. */
  ci: CheckStatus | null;
}


export interface Reviewer {
  /** A login, or a team's name. */
  name: string;
  avatarUrl: string | null;
  team: boolean;
  /** REQUESTED while their review is still asked for; else their latest review's state. */
  state: string;
}

export interface Label {
  name: string;
  /** Six hex digits, or null when GitHub sent something else. */
  color: string | null;
}

export interface PrDetail {
  forge: Forge;
  /** The forge's id of the pull request (GitHub GraphQL node id), used by some writes. */
  id: string;
  /** Head commit when read: every write is checked against it. */
  headSha: string | null;
  /** GitLab's diff refs, which anchor a line comment. */
  diffRefs?: {base: string; head: string; start: string} | null;
  /** The signed-in GitHub user looking at the PR. */
  viewer: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  authorAvatarUrl: string | null;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  onDefaultBranch: boolean;
  stackedOn: StackRef | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** Your unsubmitted review on this PR, if you started one. */
  pendingReviewId: string | null;
  reviewDecision: string | null;
  conflicts: boolean;
  /** Description first, then comments and reviews, oldest first. */
  timeline: TimelineEntry[];
  /** Unresolved first, in GitHub's order within each group. */
  threads: Thread[];
  /** Failing first, then running, passing, skipped. */
  checks: CheckDetail[];
  /** Asked-for reviewers first, then everyone else who reviewed; never the author. */
  reviewers: Reviewer[];
  labels: Label[];
  /** The description as Markdown source, for editing. */
  body: string;
  /** GitHub lets the viewer edit the title and description. */
  canEdit: boolean;
  /** The latest 100 commits, newest first. */
  commits: PrCommit[];
  commitCount: number;
  /** The commit your latest review was on, to mark what came after it. */
  myReviewOid: string | null;
}


export type ThreadStatus = "resolved" | "waiting-on-you" | "you-replied" | "waiting-on-author" | "author-replied";

export function threadStatus(t: Thread, viewer: string, author: string): ThreadStatus {
  if (t.isResolved) return "resolved";
  // awaitingReply: the last word is not the PR author's.
  if (viewer === author) return t.awaitingReply ? "waiting-on-you" : "you-replied";
  return t.awaitingReply ? "waiting-on-author" : "author-replied";
}


export type FixSubject = { kind: "thread"; thread: Thread } | { kind: "check"; check: CheckDetail };
