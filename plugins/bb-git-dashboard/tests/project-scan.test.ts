import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarker, descend, parseExclude, summarize, type Verdict } from "../src/core/catalog/project-scan.ts";

const rules = {exclude: ["node_modules", "vendor", "references"], maxDepth: 6};

test("hidden and excluded folders are not descended into", () => {
  assert.equal(descend(".worktrees", rules), "hidden");
  assert.equal(descend(".cache", rules), "hidden");
  assert.equal(descend("references", rules), "excluded");
  assert.equal(descend("node_modules", rules), "excluded");
  assert.equal(descend("Personal", rules), "descend");
  assert.equal(descend("referenced", rules), "descend");
});

test("the exclusion setting is a comma-separated list of folder names", () => {
  assert.deepEqual(parseExclude(" node_modules, vendor ,,references,a/b, .. "), ["node_modules", "vendor", "references"]);
});

test("a .git folder is a project", () => {
  assert.deepEqual(classifyMarker({path: "/p/Personal/app", git: "dir"}), {path: "/p/Personal/app", kind: "project"});
});

test("a .git file pointing into a parent's worktrees is a linked worktree of that parent", () => {
  assert.deepEqual(classifyMarker({path: "/p/agent-team/worktrees/w1", git: "file", gitdir: "/p/agent-team/.git/worktrees/w1"}),
    {path: "/p/agent-team/worktrees/w1", kind: "worktree", parent: "/p/agent-team"});
});

test("a .git file pointing into a parent's modules is a submodule of that parent", () => {
  assert.deepEqual(classifyMarker({path: "/p/infra/roles/x", git: "file", gitdir: "/p/infra/.git/modules/roles/x"}),
    {path: "/p/infra/roles/x", kind: "submodule", parent: "/p/infra"});
});

test("a .git file pointing nowhere known is skipped as broken", () => {
  assert.deepEqual(classifyMarker({path: "/p/odd", git: "file", gitdir: null}), {path: "/p/odd", kind: "skipped", reason: "broken-gitdir"});
  assert.deepEqual(classifyMarker({path: "/p/odd", git: "file", gitdir: "/elsewhere/repo.git"}), {path: "/p/odd", kind: "skipped", reason: "broken-gitdir"});
});

test("the preview counts top-level projects, nested ones, attached copies and skipped repositories by reason", () => {
  const verdicts: Verdict[] = [
    {path: "/p/a", kind: "project"}, {path: "/p/hass", kind: "project"}, {path: "/p/hass/distrib/d", kind: "project"},
    {path: "/p/a/.worktrees/x", kind: "worktree", parent: "/p/a"}, {path: "/p/infra/m", kind: "submodule", parent: "/p/infra"},
    {path: "/p/lim/references/r1", kind: "skipped", reason: "excluded"}, {path: "/p/lim/references/r2", kind: "skipped", reason: "excluded"},
    {path: "/p/.cache/c", kind: "skipped", reason: "hidden"},
  ];
  assert.deepEqual(summarize("/p", verdicts, false, 1), {
    root: "/p", truncated: false, projects: 2, nested: 1, worktrees: 1, submodules: 1,
    skipped: [{reason: "excluded", count: 2, examples: ["/p/lim/references/r1"]}, {reason: "hidden", count: 1, examples: ["/p/.cache/c"]}],
  });
});
