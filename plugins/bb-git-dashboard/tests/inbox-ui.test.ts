import assert from "node:assert/strict";
import { test } from "node:test";
import { grouped, severity, type InboxItem, type InboxList } from "../src/ui/pulls/inbox-api.ts";

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
  const list: InboxList = {tab: "open", counts: {}, groups: [{account: {id: "a", label: "A", kind: "github"}, notice: null, error: null, items: [
    item({id: "1", repo: "o/r", updatedAt: "2026-11-27T01:00:00Z"}), item({id: "2", repo: "o/s"}), item({id: "3", repo: "o/r", updatedAt: "2026-11-27T02:00:00Z"}),
    item({id: "4", repo: "o/r", title: "skip me"})]}]};
  const result = grouped(list, row => row.title !== "skip me", new Set(["a|o/s"]));
  assert.deepEqual(result[0].repos.map(repo => [repo.repo, repo.items.map(row => row.id)]), [["o/r", ["3", "1"]]]);
});
