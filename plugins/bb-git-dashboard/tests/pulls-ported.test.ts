// Ported from plugins/bb-github-pr-dashboard/prs.test.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc):
// the list, blockers, checks, stacks, search and watcher tests. Detail and review tests move with 0.7.0 and 0.8.0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesSearch } from "../src/core/pulls/model.ts";
import { checkOf, latestChecks, stackOf, toList, toPr, toWatched, type RawPr, type RawWatchPr } from "../src/core/pulls/github.ts";
import { diffWatch, pushText, type Watched } from "../src/core/pulls/watch.ts";

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

test("an approved PR with green CI has no blockers", () => {
  const pr = toPr({ ...base, reviewDecision: "APPROVED", mergeable: "MERGEABLE", commits: rollup("SUCCESS") });
  assert.equal(pr.ci, "passing");
  assert.deepEqual(pr.blockers, []);
});

test("every reason an open PR is stuck is listed, in order", () => {
  const pr = toPr({
    ...base,
    isDraft: true,
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
    commits: rollup("FAILURE", [
      { __typename: "CheckRun", name: "build", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
      { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", detailsUrl: null },
      { __typename: "StatusContext", context: "jenkins", state: "ERROR", targetUrl: null },
    ]),
  });
  assert.deepEqual(pr.failingChecks, [
    { name: "build", workflow: null, url: "https://ci/1" },
    { name: "jenkins", workflow: null, url: null },
  ]);
  assert.equal(pr.unresolvedThreads, 2);
  assert.deepEqual(pr.blockers, [
    "Draft",
    "Merge conflicts",
    "CI failing (2 checks)",
    "Changes requested",
    "2 unresolved comments",
  ]);
});

test("UNKNOWN mergeable, missing checks and pending CI", () => {
  assert.deepEqual(toPr({ ...base, mergeable: "UNKNOWN" }).blockers, []);
  assert.equal(toPr(base).ci, "none");
  const pending = toPr({ ...base, reviewDecision: "REVIEW_REQUIRED", commits: rollup("PENDING") });
  assert.deepEqual(pending.blockers, ["CI running", "Awaiting review"]);
});

test("merged PRs have no blockers and non-PR search nodes are dropped", () => {
  const list = toList({ issueCount: 2, nodes: [{ ...base, mergedAt: "2026-10-03T00:00:00Z", isDraft: true }, {}] });
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 1);
  assert.deepEqual(list.items[0]!.blockers, []);
});

test("a check names its pipeline: the Actions workflow, else the CI app", () => {
  const run = checkOf({
    __typename: "CheckRun",
    name: "test / unit",
    status: "COMPLETED",
    conclusion: "CANCELLED",
    detailsUrl: "https://ci/9",
    checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } },
    annotations: { nodes: [{ message: "boom", path: "a.go", annotationLevel: "FAILURE", location: { start: { line: 3 } } }] },
  });
  assert.equal(run.workflow, "CI");
  assert.equal(run.status, "failing");
  assert.deepEqual(run.annotations, [{ path: "a.go", line: 3, level: "FAILURE", message: "boom" }]);
  const jenkins = checkOf({ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null,
    checkSuite: { app: { name: "Jenkins" }, workflowRun: null } });
  assert.equal(jenkins.workflow, "Jenkins");
  assert.equal(jenkins.status, "pending");
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }).status, "skipped");
});

test("a run cancelled by a newer, passing run of the same job is not a failure", () => {
  const suite = { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } };
  const contexts = [
    { __typename: "CheckRun", name: "test / unit", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-02T00:00:00Z", checkSuite: suite },
    { __typename: "CheckRun", name: "test / unit", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-01T00:00:00Z", checkSuite: suite },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T00:00:00Z", checkSuite: suite },
  ];
  assert.deepEqual(latestChecks(contexts).map((c) => [c.name, c.status]), [
    ["test / unit", "passing"],
    ["lint", "failing"],
  ]);
  const pr = toPr({ ...base, commits: rollup("FAILURE", contexts.slice(0, 2)) });
  assert.equal(pr.ci, "passing");
  assert.deepEqual(pr.failingChecks, []);
});

// ---- watcher ----

const who = (login: string, at: string, type = "User") => ({ author: { __typename: type, login }, createdAt: at, url: `c/${login}/${at}` });
const run = (name: string, conclusion: string, startedAt: string) => ({
  __typename: "CheckRun", name, status: "COMPLETED", conclusion, startedAt,
  checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } },
});
const rawWatch = (over: Partial<RawWatchPr> = {}): RawWatchPr => ({
  id: "PR_9", number: 9, title: "Add retries", url: "https://github.com/o/r/pull/9", author: { login: "me" },
  repository: { nameWithOwner: "o/r" }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }, ...over,
});

test("watch: newest comment by someone else, skipping me, bots and ignored people", () => {
  const w = toWatched(rawWatch({
    comments: { nodes: [who("sam", "2026-10-02T00:00:00Z"), who("me", "2026-10-05T00:00:00Z")] },
    reviews: { nodes: [{ author: { __typename: "User", login: "priya" }, submittedAt: "2026-10-03T00:00:00Z", url: "r" }] },
    reviewThreads: { nodes: [{ comments: { nodes: [who("ci-helper", "2026-10-06T00:00:00Z"), who("dependabot", "2026-10-07T00:00:00Z", "Bot")] } }] },
  }), new Set(["ci-helper"]));
  assert.deepEqual(w.lastComment, { author: "priya", at: "2026-10-03T00:00:00Z", url: "r" });
});

test("watch: failing jobs use the latest run, so a superseded failure is ignored", () => {
  const w = toWatched(rawWatch({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    run("unit", "CANCELLED", "2026-10-01T00:00:00Z"), run("unit", "SUCCESS", "2026-10-02T00:00:00Z"), run("lint", "FAILURE", "2026-10-02T00:00:00Z"),
  ] } } } }] } }), new Set());
  assert.deepEqual(w.failing, ["CI › lint"]);
});

const pr = (over: Partial<Watched> = {}): Watched => ({ id: "PR_9", repo: "o/r", number: 9, title: "Add retries", url: "u", failing: [], lastComment: null, ...over });
const on = { ci: true, comments: true };
const T = "2026-10-10T00:00:00Z";

test("watch: the first poll only records a baseline", () => {
  const { alerts, next } = diffWatch(null, [pr({ failing: ["CI › unit"], lastComment: { author: "sam", at: T, url: "c" } })], T, on);
  assert.deepEqual(alerts, []);
  assert.deepEqual(next, { PR_9: { failing: ["CI › unit"], lastCommentAt: T } });
});

test("watch: alerts once when a job starts failing, and again only for a new job", () => {
  const first = diffWatch({ PR_9: { failing: [], lastCommentAt: null } }, [pr({ failing: ["CI › unit"] })], T, on);
  assert.deepEqual(first.alerts.map((a) => [a.kind, a.headline, a.detail]), [["ci", "CI failing · o/r#9", "CI › unit — Add retries"]]);
  assert.deepEqual(diffWatch(first.next, [pr({ failing: ["CI › unit"] })], T, on).alerts, []);
  const more = diffWatch(first.next, [pr({ failing: ["CI › unit", "CI › lint"] })], T, on);
  assert.deepEqual(more.alerts.map((a) => a.detail), ["CI › lint — Add retries"]);
});

test("watch: a newer comment alerts; an old one, a disabled kind or a brand-new PR's history does not", () => {
  const prev = { PR_9: { failing: [], lastCommentAt: "2026-10-01T00:00:00Z" } };
  const c = { author: "sam", at: "2026-10-02T00:00:00Z", url: "c" };
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: c })], T, on).alerts.map((a) => a.headline), ["sam commented · o/r#9"]);
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: { ...c, at: "2026-10-01T00:00:00Z" } })], T, on).alerts, []);
  assert.deepEqual(diffWatch(prev, [pr({ lastComment: c, failing: ["CI › unit"] })], T, { ci: false, comments: false }).alerts, []);
  // A PR not in the previous snapshot: CI counts, its existing comments do not.
  const fresh = diffWatch({}, [pr({ lastComment: c, failing: ["CI › unit"] })], T, on);
  assert.deepEqual(fresh.alerts.map((a) => a.kind), ["ci"]);
});

test("push: one alert keeps its own text; several from one check become one summary", () => {
  const { alerts } = diffWatch({}, [pr({ failing: ["CI › unit"] }), pr({ id: "PR_10", number: 10, failing: ["CI › lint"] })], T, on);
  assert.deepEqual(pushText(alerts.slice(0, 1)), { title: "CI failing · o/r#9", body: "CI › unit — Add retries" });
  assert.deepEqual(pushText(alerts), { title: "2 new PR alerts", body: "CI failing · o/r#9\nCI failing · o/r#10" });
});

test("stacks: a PR based on another PR's branch is stacked; the default branch never is", () => {
  const parent = { number: 2284, title: "Usecase", url: "u" };
  const repo = { nameWithOwner: "o/r", defaultBranchRef: { name: "master" } };
  assert.deepEqual(stackOf({ baseRefName: "feat/usecase", repository: repo, baseRef: { associatedPullRequests: { nodes: [parent] } } }),
    { onDefaultBranch: false, stackedOn: parent });
  // GitHub links master to an unrelated PR (seen live as #393); it must not count as a parent.
  assert.deepEqual(stackOf({ baseRefName: "master", repository: repo, baseRef: { associatedPullRequests: { nodes: [{ ...parent, number: 393 }] } } }),
    { onDefaultBranch: true, stackedOn: null });
  // Parent merged and its branch deleted: still not on the default branch, but no parent PR.
  assert.deepEqual(stackOf({ baseRefName: "feat/usecase", repository: repo, baseRef: null }), { onDefaultBranch: false, stackedOn: null });
  const stacked = toPr({ ...base, baseRefName: "feat/usecase", repository: repo, baseRef: { associatedPullRequests: { nodes: [parent] } } });
  assert.deepEqual(stacked.blockers, ["Stacked on #2284"]);
});

test("search matches every word across title, number, repo, author and blockers", () => {
  const pr = { ...toPr({ ...base, author: { login: "priya-n" } } as RawPr), blockers: ["CI failing (1 check)"] };
  assert.equal(matchesSearch(pr, ""), true);
  assert.equal(matchesSearch(pr, "  "), true);
  assert.equal(matchesSearch(pr, "fix"), true);
  assert.equal(matchesSearch(pr, "#7"), true);
  assert.equal(matchesSearch(pr, "o/r PRIYA"), true);
  assert.equal(matchesSearch(pr, "failing fix"), true);
  assert.equal(matchesSearch(pr, "fix #8"), false);
  assert.equal(matchesSearch(pr, "sam"), false);
});

test("a review goes stale when the author pushes after it or it is dismissed", () => {
  const reviewed = (state: string, reviewedOid: string, headRefOid = "abc") =>
    toPr({ ...base, headRefOid, viewerLatestReview: { state, commit: { oid: reviewedOid } } }).myReview;
  assert.deepEqual(reviewed("APPROVED", "abc"), { state: "APPROVED", stale: false });
  assert.deepEqual(reviewed("APPROVED", "old"), { state: "APPROVED", stale: true });
  assert.deepEqual(reviewed("CHANGES_REQUESTED", "old"), { state: "CHANGES_REQUESTED", stale: true });
  assert.deepEqual(reviewed("DISMISSED", "abc"), { state: "DISMISSED", stale: true });
  assert.equal(toPr(base).myReview, null);
});
