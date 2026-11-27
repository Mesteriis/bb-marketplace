import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, grouped, openStats, severity, showing, type InboxItem, type InboxList } from "../src/ui/pulls/inbox-api.ts";

const item = (over: Partial<InboxItem>): InboxItem => ({id: "1", number: 1, title: "T", url: "https://github.com/o/r/pull/1", repo: "o/r", author: "a",
  baseRefName: "main", headRefName: "f", onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "", updatedAt: "2026-11-27T00:00:00Z",
  mergedAt: null, closedAt: null, additions: null, deletions: null, ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [],
  reviewDecision: null, conflicts: false, blockers: [], myReview: null, forge: "github", accountId: "a", ...over});

test("the stripe is red for what stops a merge, amber for waiting, none when ready or done", () => {
  assert.equal(severity(item({conflicts: true, blockers: ["Merge conflicts"]})), "red");
  assert.equal(severity(item({ci: "failing", blockers: ["CI failing"]})), "red");
  assert.equal(severity(item({reviewDecision: "CHANGES_REQUESTED", blockers: ["Changes requested"]})), "red");
  assert.equal(severity(item({blockers: ["Awaiting review"]})), "amber");
  assert.equal(severity(item({})), "none");
  assert.equal(severity(item({conflicts: true, mergedAt: "2026-11-27T01:00:00Z"})), "none");
});

test("rows are grouped by account and repository, newest first, without hidden repositories or misses", () => {
  const list: InboxList = {tab: "open", counts: {}, groups: [{account: {id: "a", label: "A", kind: "github"}, total: null, notice: null, error: null, items: [
    item({id: "1", repo: "o/r", updatedAt: "2026-11-27T01:00:00Z"}), item({id: "2", repo: "o/s"}), item({id: "3", repo: "o/r", updatedAt: "2026-11-27T02:00:00Z"}),
    item({id: "4", repo: "o/r", title: "skip me"})]}]};
  const result = grouped(list, row => row.title !== "skip me", new Set(["a|o/s"]));
  assert.deepEqual(result[0].repos.map(repo => [repo.repo, repo.items.map(row => row.id)]), [["o/r", ["3", "1"]]]);
});

test("pull request and issue pages are addressed by account, number and repository path", async () => {
  const {parseRef, refPath} = await import("../src/ui/review/review-api.ts");
  const path = refPath("pr", {accountId: "gl", repo: "group/sub/app", number: 7});
  assert.equal(path, "pr/gl/7/group/sub/app");
  assert.deepEqual(parseRef(path), {kind: "pr", accountId: "gl", repo: "group/sub/app", number: 7});
  assert.deepEqual(parseRef("issue/gh/new/o/r"), {kind: "issue", accountId: "gh", repo: "o/r", number: "new"});
  assert.deepEqual(parseRef("pr/az/3/My Project/app"), {kind: "pr", accountId: "az", repo: "My Project/app", number: 3});
  assert.equal(parseRef("pr/gh/new/o/r"), null);
  assert.equal(parseRef("pr/gh/0/o/r"), null);
  assert.equal(parseRef("pr/gh/1/o"), null);
  assert.equal(parseRef("pr/gh/1/o/../r"), null);
});

test("the Open tiles count failing CI, unresolved comments, changes requested and nothing blocking", () => {
  assert.deepEqual(openStats([item({ci: "failing", unresolvedThreads: 2, blockers: ["CI failing", "2 unresolved"]}), item({reviewDecision: "CHANGES_REQUESTED", blockers: ["Changes requested"]}),
    item({unresolvedThreads: 1, blockers: ["1 unresolved"]}), item({}), item({isDraft: true, blockers: ["Draft"]})]),
  {ciFailing: 1, unresolved: 2, changesRequested: 1, ready: 1});
});

test("times read as minutes, hours or days ago", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.deepEqual([ago(now - 20_000, now), ago(now - 5 * 60_000, now), ago(now - 3 * 3_600_000, now), ago(now - 2 * 86_400_000, now), ago(now + 5_000, now)],
    ["just now", "5 min ago", "3 h ago", "2 d ago", "just now"]);
});

test("a list cut short says how many it shows of how many", () => {
  assert.equal(showing(30, 120, false), "Showing the 30 most recently updated of 120.");
  assert.equal(showing(30, 120, true), "Showing the 30 most recently updated of 120. Search to reach the older ones.");
  assert.equal(showing(30, 30, true), null);
  assert.equal(showing(30, null, true), null);
});
