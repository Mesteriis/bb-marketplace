import test from "node:test";
import assert from "node:assert/strict";
import { blockersOf, type InboxPr } from "../src/core/pulls/model.ts";
import type { Run } from "../src/core/ci/model.ts";
import type { CopyState } from "../src/core/overview/items.ts";
import { categoriesOf, projectTable, viewRows } from "../src/core/projects/table.ts";
import { nestedFolders, projectTree } from "../src/core/project-workspace.ts";

const pr = (number: number, more: Partial<InboxPr> = {}): InboxPr => {
  const row: InboxPr = {id: "p" + number, number, title: "PR " + number, url: "https://git.example.org/team/web/pulls/" + number, repo: "team/web",
    author: "me", baseRefName: "main", headRefName: "feature", onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-28T10:00:00Z", mergedAt: null, closedAt: null, additions: 1, deletions: 1, ci: "passing", failingChecks: [], unresolvedThreads: 0,
    notes: [], reviewDecision: "APPROVED", conflicts: false, blockers: [], myReview: null, forge: "github", accountId: "acc", ...more};
  return {...row, blockers: blockersOf(row)};
};
const run = (id: string, state: Run["state"], createdAt: string): Run => ({id, number: 1, workflow: "ci", workflowId: null, title: "build", branch: "main",
  sha: null, event: "push", state, attempt: 1, createdAt, updatedAt: null, url: null, actor: null});
const state = (copyId: string, more: Partial<CopyState> = {}): CopyState =>
  ({copyId, name: "web", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: 0, at: null, ...more});
const entry = (copyId: string, category: string, more: Partial<CopyState> = {}, name = "web") =>
  ({copyId, name, repository: "git.example.org/team/" + name, category, state: state(copyId, {name, ...more})});

test("a row per copy with its pull request (same repository and branch) and its newest run", () => {
  const {rows} = projectTable({copies: [entry("a", "Work", {branch: "feature", files: 3, ahead: 2}), entry("b", "Personal", {}, "api"),
    {copyId: "c", name: "gone", repository: null, category: "Work", state: null}],
    mine: [pr(1, {headRefName: "feature"}), pr(2, {repo: "team/api", headRefName: "other"})],
    runs: [{copyId: "a", repository: "team/web", runs: [run("1", "success", "2026-11-28T09:00:00Z"), run("2", "failure", "2026-11-28T11:00:00Z")]}]});
  assert.deepEqual(rows.map(row => [row.copyId, row.category, row.branch, row.files, row.ahead, row.pr?.number ?? null, row.ci?.id ?? null, row.unreadable]), [
    ["a", "Work", "feature", 3, 2, 1, "2", false],
    ["b", "Personal", "main", 0, 0, null, null, false],
    ["c", "Work", null, null, 0, null, null, true],
  ]);
});

test("the views: needs attention, with changes, my pull requests, CI failed — each counted", () => {
  const table = projectTable({copies: [
    entry("ci", "W", {}, "ci"), entry("conflict", "W", {branch: "x"}, "conflict"), entry("behind", "W", {behind: 3}, "behind"),
    entry("dirty", "W", {files: 2}, "dirty"), entry("ahead", "W", {ahead: 1}, "ahead"), entry("unpublished", "W", {upstream: null, branch: "spike"}, "unpublished"),
    entry("clean", "W", {}, "clean"),
  ], mine: [pr(1, {repo: "team/conflict", headRefName: "x", conflicts: true}), pr(2, {repo: "team/clean", headRefName: "main"})],
  runs: [{copyId: "ci", repository: "team/ci", runs: [run("9", "failure", "2026-11-28T11:00:00Z")]}]});
  const ids = (view: Parameters<typeof viewRows>[1]) => viewRows(table.rows, view).map(row => row.copyId);
  assert.deepEqual(ids("attention"), ["ci", "conflict", "behind"]);
  assert.deepEqual(ids("changes"), ["dirty", "ahead", "unpublished"]);
  assert.deepEqual(ids("mine"), ["conflict", "clean"]);
  assert.deepEqual(ids("ci-failed"), ["ci"]);
  assert.equal(ids("all").length, 7);
  assert.deepEqual(table.counts, {all: 7, attention: 3, changes: 3, mine: 2, "ci-failed": 1});
});

test("each project's category is the top folder of the tree it sits under", () => {
  const folders = nestedFolders(projectTree([
    {id: "a", name: "A", folder: {path: "/home/owner/projects/Personal", hostId: "local"}},
    {id: "b", name: "B", folder: {path: "/home/owner/projects/Work/clients", hostId: "local"}},
    {id: "c", name: "C", folder: {path: "/home/owner/projects/Work", hostId: "local"}},
  ], []), "");
  assert.deepEqual([...categoriesOf(folders).entries()].sort(), [["a", "Personal"], ["b", "Work"], ["c", "Work"]]);
});
