import test from "node:test";
import assert from "node:assert/strict";
import { blockersOf, type InboxPr } from "../src/core/pulls/model.ts";
import type { Run } from "../src/core/ci/model.ts";
import type { CopyState } from "../src/core/overview/items.ts";
import { categoriesOf, copyRepositories, projectTable, viewRows } from "../src/core/projects/table.ts";
import { nestedFolders, projectTree } from "../src/core/project-workspace.ts";

const pr = (number: number, more: Partial<InboxPr> = {}): InboxPr => {
  const row: InboxPr = {id: "p" + number, number, title: "PR " + number, url: "https://git.example.org/team/web/pulls/" + number, repo: "team/web",
    author: "me", baseRefName: "main", headRefName: "feature", onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "2026-11-27T10:00:00Z",
    updatedAt: "2026-11-28T10:00:00Z", mergedAt: null, closedAt: null, additions: 1, deletions: 1, ci: "passing", failingChecks: [], unresolvedThreads: 0,
    notes: [], reviewDecision: "APPROVED", conflicts: false, blockers: [], myReview: null, forge: "github", accountId: "acc", ...more};
  return {...row, blockers: blockersOf(row)};
};
const run = (id: string, state: Run["state"], createdAt: string, branch = "main"): Run => ({id, number: 1, workflow: "ci", workflowId: null, title: "build", branch,
  sha: null, event: "push", state, attempt: 1, createdAt, updatedAt: null, url: null, actor: null});
const state = (copyId: string, more: Partial<CopyState> = {}): CopyState =>
  ({copyId, name: "web", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, files: 0, at: null, ...more});
const entry = (copyId: string, category: string, more: Partial<CopyState> = {}, name = "web") =>
  ({copyId, name, place: "mac · /home/owner/projects/" + name, repository: "git.example.org/team/" + name, category, state: state(copyId, {name, ...more})});

test("a row per copy with its pull request (same repository and branch) and its newest run", () => {
  const {rows} = projectTable({copies: [entry("a", "Work", {branch: "feature", files: 3, ahead: 2}), entry("b", "Personal", {}, "api"),
    {copyId: "c", name: "gone", place: "mac · /gone", repository: null, category: "Work", state: null}],
    mine: [pr(1, {headRefName: "feature"}), pr(2, {repo: "team/api", headRefName: "other"})],
    runs: [{copyId: "a", repository: "team/web", runs: [run("1", "success", "2026-11-28T09:00:00Z", "feature"), run("2", "failure", "2026-11-28T11:00:00Z", "feature"),
      run("3", "success", "2026-11-28T12:00:00Z", "main")]}]});
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

test("projects straight in the projects folder take its name; a folder below it is a category of its own", () => {
  const folders = nestedFolders(projectTree([
    {id: "a", name: "A", folder: {path: "/home/owner/projects", hostId: "local"}},
    {id: "d", name: "D", folder: {path: "/home/owner/projects/Work", hostId: "local"}},
    {id: "e", name: "E", folder: {path: "/home/owner/projects/Work/clients", hostId: "local"}},
  ], []), "");
  assert.deepEqual([...categoriesOf(folders).entries()].sort(), [["a", "projects"], ["d", "Work"], ["e", "Work"]]);
});

test("a copy's CI is the newest run of its own branch; another worktree of the repository takes its repository and runs", () => {
  const {rows} = projectTable({copies: [entry("main", "W", {}, "web"), {...entry("wt", "W", {branch: "feature"}, "web"), repository: "team/web"},
    {...entry("other", "W", {branch: "spike"}, "web"), repository: "team/web"}],
    mine: [pr(7, {headRefName: "feature"})],
    runs: [{copyId: "main", repository: "team/web", runs: [run("m", "success", "2026-11-28T09:00:00Z"), run("f", "failure", "2026-11-28T10:00:00Z", "feature")]}]});
  assert.deepEqual(rows.map(row => [row.copyId, row.ci?.id ?? null, row.pr?.number ?? null]), [["main", "m", null], ["wt", "f", 7], ["other", null, null]]);
});

test("the repository read for one copy goes to every copy of its Git directory, and only to them", () => {
  const groups = new Map([["a", "mac/r1"], ["a2", "mac/r1"], ["b", "mac/r2"], ["c", "linux/r1"]]);
  assert.deepEqual([...copyRepositories([{copyId: "a", repository: "team/web", runs: []}], groups).entries()].sort(), [["a", "team/web"], ["a2", "team/web"]]);
});

test("the overview of one category: its copies and their runs, pull requests of their repositories; others only under All", async () => {
  const {inCategory} = await import("../src/core/overview/category.ts");
  const input = {mine: [pr(1, {repo: "team/web"}), pr(2, {repo: "team/api"}), pr(3, {repo: "elsewhere/lib"})],
    requested: [pr(4, {repo: "Team/API"})], merged: [pr(5, {repo: "team/web"})],
    runs: [{copyId: "w", repository: "team/web", runs: []}, {copyId: "a", repository: "team/api", runs: []}],
    copies: [state("w"), state("a", {name: "api"})], now: 0};
  const categories = new Map([["w", "Work"], ["a", "Personal"], ["w2", "Personal"]]);
  // w2 is another worktree of team/web, in Personal, with no runs of its own: its repository's runs and PRs show there too.
  const repositories = new Map([["w", "team/web"], ["a", "team/api"], ["w2", "team/web"]]);
  const work = inCategory(input, "Work", categories, repositories);
  assert.deepEqual([work.copies.map(c => c.copyId), work.runs.map(r => r.copyId), work.mine.map(p => p.number), work.requested.map(p => p.number), work.merged.map(p => p.number)],
    [["w"], ["w"], [1], [], [5]]);
  const personal = inCategory(input, "Personal", categories, repositories);
  assert.deepEqual([personal.mine.map(p => p.number), personal.requested.map(p => p.number), personal.runs.map(r => r.copyId)], [[1, 2], [4], ["w", "a"]]);
  assert.equal(inCategory(input, null, categories, repositories), input);
});
