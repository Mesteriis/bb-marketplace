// Ported from plugins/bb-github-pr-dashboard/prs.test.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc):
// detail, files, patch, review rules, prompts and agent target tests. GitHub link, viewer-selection and Jira tests
// stay behind with features Makosh Git does not have.
import assert from "node:assert/strict";
import { test } from "node:test";
import { threadStatus, type Thread } from "../src/core/pulls/detail.ts";
import { toDetail, type RawDetail } from "../src/core/pulls/github-detail.ts";
import { checkOf, toPr, type RawPr } from "../src/core/pulls/github.ts";
import { commentRange, commentTarget, fullPatch, parsePatch, toFiles } from "../src/core/pulls/diff.ts";
import { canSubmitReview, reviewEvents } from "../src/core/pulls/review.ts";
import { findingsPrompt, fixPrompt } from "../src/core/pulls/prompt.ts";
import { agentTarget, linkCandidates, projectFor, repoOfRemote, type AgentThread } from "../src/core/pulls/agent-target.ts";

const base: RawPr = {
  id: "PR_1",
  number: 7,
  title: "Fix it",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  repository: { nameWithOwner: "o/r" },
};

function rollup(state: string, nodes: object[] = []) {
  return { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes } } } }] };
}

const me = { login: "me" };
const c = (login: string, at: string) => ({ author: { login }, body: `${login} says`, createdAt: at, url: `u/${at}` });
const rawDetail: RawDetail = {
  number: 1, title: "T", url: "https://github.com/o/r/pull/1", isDraft: false, state: "OPEN",
  createdAt: "2026-10-01T00:00:00Z", body: "Description", author: me, headRefName: "feat", baseRefName: "main",
  reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", repository: { nameWithOwner: "o/r" },
  reviewThreads: { nodes: [
    { isResolved: true, isOutdated: false, viewerCanUnresolve: true, path: "a.go", line: 1, originalLine: 1, resolvedBy: me,
      comments: { nodes: [c("rev", "2026-10-02T00:00:00Z"), c("me", "2026-10-03T00:00:00Z")] } },
    { isResolved: false, isOutdated: true, path: "b.go", line: null, originalLine: 7, resolvedBy: null,
      comments: { nodes: [c("rev", "2026-10-02T00:00:00Z"), c("me", "2026-10-03T00:00:00Z")] } },
    { isResolved: false, isOutdated: false, viewerCanUnresolve: true, path: "c.go", line: 4, originalLine: 4, resolvedBy: null,
      comments: { nodes: [{ ...c("rev", "2026-10-02T00:00:00Z"), diffHunk: "@@ x\n-a\n+b" }] } },
  ] },
  comments: { nodes: [c("bot", "2026-10-05T00:00:00Z")] },
  reviews: { nodes: [
    { author: { login: "rev" }, state: "COMMENTED", body: "", submittedAt: "2026-10-02T00:00:00Z", url: "r1" },
    { author: { login: "rev" }, state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-10-04T00:00:00Z", url: "r2" },
  ] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "StatusContext", context: "ok", state: "SUCCESS" },
    { __typename: "StatusContext", context: "bad", state: "FAILURE", description: "tests failed" },
  ] } } } }] },
};

test("detail: unresolved threads first, who has the last word, and the timeline", () => {
  const d = toDetail(rawDetail);
  assert.deepEqual(d.threads.map((t) => [t.path, t.isResolved, t.awaitingReply]), [
    ["b.go", false, false], // I replied last
    ["c.go", false, true], // reviewer is waiting on me
    ["a.go", true, false],
  ]);
  assert.equal(d.threads[0]!.line, 7); // outdated: falls back to the original line
  assert.equal(d.threads[1]!.diffHunk, "@@ x\n-a\n+b");
  // The permission that matters follows the state: resolve while open, unresolve once resolved.
  assert.deepEqual(d.threads.map((t) => t.canToggleResolved), [false, false, true]);
  // Description, the CHANGES_REQUESTED review, then the comment; the bare COMMENTED review is dropped.
  assert.deepEqual(d.timeline.map((t) => [t.author, t.reviewState]), [
    ["me", null],
    ["rev", "CHANGES_REQUESTED"],
    ["bot", null],
  ]);
  assert.deepEqual(d.checks.map((k) => [k.name, k.status, k.title]), [
    ["bad", "failing", "tests failed"],
    ["ok", "passing", null],
  ]);
});

test("thread status depends on who is looking", () => {
  const t = (awaitingReply: boolean, isResolved = false) => ({ ...toDetail(rawDetail).threads[0]!, awaitingReply, isResolved });
  assert.equal(threadStatus(t(true), "me", "me"), "waiting-on-you");
  assert.equal(threadStatus(t(false), "me", "me"), "you-replied");
  assert.equal(threadStatus(t(true), "rev", "me"), "waiting-on-author");
  assert.equal(threadStatus(t(false), "rev", "me"), "author-replied");
  assert.equal(threadStatus(t(true, true), "rev", "me"), "resolved");
  assert.equal(toDetail(rawDetail, "rev").viewer, "rev");
});

test("files: renames keep the old path; binary and huge patches have no diff", () => {
  assert.deepEqual(toFiles([
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    { filename: "big.json", status: "modified", additions: 9, deletions: 9, patch: "x".repeat(200_001) },
  ]).map((f) => [f.path, f.previousPath, f.patch === null ? null : "patch"]), [
    ["src/new.ts", "src/old.ts", "patch"],
    ["logo.png", null, null],
    ["big.json", null, null],
  ]);
});

// ---- reviewing ----

test("patch: line numbers across hunks, deletions, no-newline markers and a trailing newline", () => {
  const rows = parsePatch([
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old a",
    "-old b",
    "+new a",
    "\\ No newline at end of file",
    "@@ -10 +10,2 @@ fn()",
    " ctx",
    "+added",
    "",
  ].join("\n"));
  assert.deepEqual(rows.map((r) => [r.kind, r.oldLine, r.newLine]), [
    ["hunk", null, null],
    ["ctx", 1, 1],
    ["del", 2, null],
    ["del", 3, null],
    ["add", null, 2],
    ["hunk", null, null],
    ["ctx", 10, 10],
    ["add", null, 11],
  ]);
  assert.deepEqual(rows.map(commentTarget), [
    null, { side: "RIGHT", line: 1 }, { side: "LEFT", line: 2 }, { side: "LEFT", line: 3 }, { side: "RIGHT", line: 2 },
    null, { side: "RIGHT", line: 10 }, { side: "RIGHT", line: 11 },
  ]);
});

test("review rules: no approving your own PR; changes need a reason; comment needs text or line comments", () => {
  assert.deepEqual(reviewEvents("me", "me"), ["COMMENT"]);
  assert.deepEqual(reviewEvents("me", "sam"), ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
  assert.equal(canSubmitReview("APPROVE", "", 0), true);
  assert.equal(canSubmitReview("REQUEST_CHANGES", "  ", 3), false);
  assert.equal(canSubmitReview("REQUEST_CHANGES", "Fix the cap", 0), true);
  assert.equal(canSubmitReview("COMMENT", "", 0), false);
  assert.equal(canSubmitReview("COMMENT", "", 2), true);
});

test("detail: your pending review and its draft threads are recognised", () => {
  const raw = structuredClone(rawDetail);
  raw.pendingReview = { nodes: [{ id: "PRR_pending" }] };
  raw.reviewThreads.nodes[2]!.diffSide = "LEFT";
  (raw.reviewThreads.nodes[2]!.comments.nodes[0] as { state?: string }).state = "PENDING";
  const d = toDetail(raw, "me");
  assert.equal(d.pendingReviewId, "PRR_pending");
  const draft = d.threads.find((t) => t.path === "c.go")!;
  assert.deepEqual([draft.isPending, draft.side], [true, "LEFT"]);
  assert.equal(d.threads.filter((t) => t.isPending).length, 1);
});

test("multi-line range: ordered, anchored on the last row, kept inside one hunk", () => {
  const rows = parsePatch(["@@ -1,3 +1,3 @@", " keep", "-old", "+new", "@@ -10 +10 @@", " later"].join("\n"));
  // rows: 0 hunk, 1 ctx(1/1), 2 del(old 2), 3 add(new 2), 4 hunk, 5 ctx(10/10)
  assert.deepEqual(commentRange(rows, 3, 1), { side: "RIGHT", line: 2, start: { side: "RIGHT", line: 1 } });
  assert.deepEqual(commentRange(rows, 2, 3), { side: "RIGHT", line: 2, start: { side: "LEFT", line: 2 } });
  assert.deepEqual(commentRange(rows, 1, 1), { side: "RIGHT", line: 1, start: null });
  assert.equal(commentRange(rows, 3, 5), null); // crosses a hunk header
  assert.equal(commentRange(rows, 0, 1), null); // a hunk header is not a line
});

test("detail: a multi-line thread keeps its first line", () => {
  const raw = structuredClone(rawDetail);
  raw.reviewThreads.nodes[1]!.startLine = 4;
  assert.equal(toDetail(raw).threads.find((t) => t.path === "b.go")!.startLine, 4);
});

test("full patch: git headers for modified, added, removed and renamed files", () => {
  const hunk = "@@ -1 +1 @@\n-a\n+b";
  assert.equal(fullPatch({ path: "s/x.ts", previousPath: null, status: "modified", patch: hunk }),
    "diff --git a/s/x.ts b/s/x.ts\n--- a/s/x.ts\n+++ b/s/x.ts\n" + hunk);
  assert.match(fullPatch({ path: "n.ts", previousPath: null, status: "added", patch: hunk }), /^diff --git a\/n.ts b\/n.ts\n--- \/dev\/null\n\+\+\+ b\/n.ts\n/);
  assert.match(fullPatch({ path: "o.ts", previousPath: null, status: "removed", patch: hunk }), /\n--- a\/o.ts\n\+\+\+ \/dev\/null\n/);
  assert.match(fullPatch({ path: "new.ts", previousPath: "old.ts", status: "renamed", patch: hunk }), /^diff --git a\/old.ts b\/new.ts\n--- a\/old.ts\n\+\+\+ b\/new.ts\n/);
});

const fixPr = { url: "https://github.com/o/r/pull/7", repo: "o/r", headRefName: "feat/x" };

test("fix prompt for a review thread: where, who, every reply, and a fence the bot's code block cannot close", () => {
  const thread: Thread = {
    id: "T1", path: "deploy/service.yaml", side: "LEFT", startLine: 98, line: 100, isPending: false,
    isResolved: false, isOutdated: false, resolvedBy: null, canToggleResolved: false, diffHunk: null, awaitingReply: true,
    comments: [
      { id: "", canDelete: false, author: "review-helper[bot]", avatarUrl: null, body: "Use a list:\n```yaml\na: [1]\n```", createdAt: "", url: "https://github.com/o/r/pull/7#c1" },
      { id: "", canDelete: false, author: "me", avatarUrl: null, body: "Why?", createdAt: "", url: "https://github.com/o/r/pull/7#c2" },
    ],
  };
  const prompt = fixPrompt(fixPr, { kind: "thread", thread });
  assert.match(prompt, /^Pull request https:\/\/github\.com\/o\/r\/pull\/7 \(o\/r, branch `feat\/x`\)\./);
  assert.match(prompt, /In `deploy\/service\.yaml` at lines 98–100 \(a line of the old version\) — review comment from @review-helper\[bot\] \(https:\/\/github\.com\/o\/r\/pull\/7#c1\):\n````\nUse a list:\n```yaml\na: \[1\]\n```\n````/);
  assert.match(prompt, /Reply from @me:\n```\nWhy\?\n```/);
});

test("fix prompt for a failed job: its pipeline, errors and logs", () => {
  const prompt = fixPrompt(fixPr, {
    kind: "check",
    check: {
      name: "test", workflow: "CI", status: "failing", conclusion: "TIMED_OUT", url: "https://ci/1", title: null, summary: "ignored",
      annotations: [{ path: "a.ts", line: 3, level: "FAILURE", message: "boom" }],
    },
  });
  assert.match(prompt, /The CI job "CI \/ test" failed \(timed out\)\./);
  assert.match(prompt, /Errors from the run:\n```\na\.ts:3 FAILURE: boom\n```/);
  assert.match(prompt, /Logs: https:\/\/ci\/1/);
  assert.doesNotMatch(prompt, /ignored/);
});

test("repo of a git remote, https or ssh, any case", () => {
  assert.equal(repoOfRemote("https://github.com/Acme/Payments-Live.git"), "acme/payments-live");
  assert.equal(repoOfRemote("git@github.com:o/r.js.git"), "o/r.js");
  assert.equal(repoOfRemote("https://gitlab.com/o/r.git"), null);
  assert.equal(repoOfRemote(null), null);
});

test("the PR's thread is on its branch in its repo; bb's PR status for the environment overrides the remote", () => {
  const t = (id: string, projectId: string, over: Partial<AgentThread> = {}): AgentThread => ({
    id, projectId, environmentId: `env_${id}`, environmentBranchName: "feat/x", archivedAt: null, updatedAt: 1, title: id, titleFallback: null, ...over,
  });
  const projects = [
    { id: "p_r", gitRemoteUrl: "git@github.com:o/r.git" },
    { id: "p_other", gitRemoteUrl: "https://github.com/o/other.git" },
    { id: "p_folder", gitRemoteUrl: null },
  ];
  // Same branch name in another repo, and an archived thread: neither is the PR's.
  assert.deepEqual(agentTarget(fixPr, [t("a", "p_other"), t("b", "p_r", { archivedAt: 5 })], projects, {}), { thread: null, projectId: "p_r" });
  // By remote, the newest wins.
  assert.equal(agentTarget(fixPr, [t("old", "p_r"), t("new", "p_r", { updatedAt: 9 })], projects, {}).thread?.id, "new");
  // PR status confirms a thread whose project has no remote, and rejects one whose branch has another PR.
  const target = agentTarget(
    fixPr,
    [t("folder", "p_folder"), t("stale", "p_r", { updatedAt: 9 })],
    projects,
    { env_folder: "https://github.com/O/R/pull/7", env_stale: "https://github.com/o/r/pull/6" },
  );
  assert.deepEqual(target.thread, { id: "folder", title: "folder" });
});

test("commits come newest first, with CI and the commit you last reviewed", () => {
  const commit = (oid: string, state: string | null, user: string | null) => ({
    commit: {
      oid, abbreviatedOid: oid.slice(0, 7), messageHeadline: `fix ${oid}`, committedDate: "2026-01-01T00:00:00Z",
      statusCheckRollup: state ? { state } : null,
      author: { name: "Dev Name", avatarUrl: null, user: user ? { login: user } : null },
    },
  });
  const d = toDetail({
    ...rawDetail,
    viewerLatestReview: { commit: { oid: "aaaaaaa1" } },
    history: { totalCount: 120, nodes: [commit("aaaaaaa1", "SUCCESS", "dev"), commit("bbbbbbb2", "FAILURE", null)] },
  });
  assert.deepEqual(d.commits.map((c) => [c.shortOid, c.ci, c.author]), [["bbbbbbb", "failing", "Dev Name"], ["aaaaaaa", "passing", "dev"]]);
  assert.equal(d.commitCount, 120);
  assert.equal(d.myReviewOid, "aaaaaaa1");
  assert.deepEqual(toDetail(rawDetail).commits, []);
});

test("only comments GitHub lets you delete carry a delete id", () => {
  const d = toDetail({
    ...rawDetail,
    id: "PR_1",
    comments: { nodes: [{ ...c("me", "2026-10-05T00:00:00Z"), id: "IC_1", viewerCanDelete: true }, c("bot", "2026-10-06T00:00:00Z")] },
  });
  const [description, ...rest] = d.timeline;
  assert.deepEqual([description!.id, description!.canDelete], ["", false]);
  assert.deepEqual(rest.map((e) => [e.id, e.canDelete, e.reviewState]), [
    ["", false, "CHANGES_REQUESTED"],
    ["IC_1", true, null],
    ["", false, null],
  ]);
});

test("reviewers: asked-for first, then other reviewers, never the author; labels keep only hex colours", () => {
  const d = toDetail({
    ...rawDetail,
    reviewRequests: { nodes: [
      { requestedReviewer: { __typename: "User", login: "ana", avatarUrl: null } },
      { requestedReviewer: { __typename: "Team", name: "platform", avatarUrl: null } },
    ] },
    latestReviews: { nodes: [
      { author: { login: "ana" }, state: "APPROVED" },
      { author: { login: "bo" }, state: "CHANGES_REQUESTED" },
      { author: me, state: "COMMENTED" },
    ] },
    labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "red;x" }] },
  });
  assert.deepEqual(d.reviewers.map((r) => [r.name, r.team, r.state]), [
    ["ana", false, "REQUESTED"],
    ["platform", true, "REQUESTED"],
    ["bo", false, "CHANGES_REQUESTED"],
  ]);
  assert.deepEqual(d.labels, [{ name: "bug", color: "d73a4a" }, { name: "odd", color: null }]);
});

test("projectFor: git remote first, then a project named like the repo, never a guess between two", () => {
  const p = (id: string, name: string, gitRemoteUrl: string | null = null) => ({ id, name, gitRemoteUrl });
  assert.equal(projectFor("acme/billing-api", [p("a", "billing-api"), p("b", "x", "git@github.com:acme/billing-api.git")]), "b");
  assert.equal(projectFor("acme/billing-api", [p("a", "Billing API"), p("c", "other")]), "a");
  assert.equal(projectFor("acme/billing-api", [p("a", "billing-api-v2")]), "a");
  assert.equal(projectFor("acme/billing-api", [p("a", "billing-api-v2"), p("b", "new-billing-api")]), null);
});

test("link candidates: the branch thread, then the project's, then the rest", () => {
  const t = (id: string, projectId: string, updatedAt: number, archivedAt: number | null = null) => ({
    id, projectId, updatedAt, archivedAt, environmentId: null, environmentBranchName: null, title: id, titleFallback: null,
  });
  const out = linkCandidates([t("x", "p2", 9), t("y", "p1", 1), t("z", "p1", 5), t("old", "p1", 7, 3)], [{ id: "p1", name: "repo" }], { thread: { id: "y" }, projectId: "p1" });
  assert.deepEqual(out.map((r) => [r.id, r.project]), [["y", "repo"], ["z", "repo"], ["x", ""]]);
});

test("findings prompt: every unresolved thread and failed job, numbered", () => {
  const d = toDetail(rawDetail);
  const subjects = [
    ...d.threads.filter((x) => !x.isResolved).map((thread) => ({ kind: "thread" as const, thread })),
    ...d.checks.filter((c) => c.status === "failing").map((check) => ({ kind: "check" as const, check })),
  ];
  const text = findingsPrompt(d, subjects);
  assert.match(text, /### 1\. Review comment/);
  assert.match(text, /### 3\. Failed CI job/);
  assert.match(text, /Fix what is blocking it on branch `feat`/);
});
