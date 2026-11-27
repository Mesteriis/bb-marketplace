import test from "node:test";
import assert from "node:assert/strict";
import { projectTree, type ProjectNode } from "../src/core/catalog/project-tree.ts";
import type { Verdict } from "../src/core/catalog/project-scan.ts";

const outline = (nodes: ProjectNode[], depth = 0): string[] =>
  nodes.flatMap(node => ["  ".repeat(depth) + node.kind + " " + node.path, ...outline(node.children, depth + 1)]);

test("nested repositories hang under the nearest enclosing project", () => {
  const verdicts: Verdict[] = [
    {path: "/p/Personal/infra/pool/guests/vm/101", kind: "project"},
    {path: "/p/hass", kind: "project"},
    {path: "/p/Personal/infra", kind: "project"},
    {path: "/p/hass/distrib/card", kind: "project"},
    {path: "/p/Personal/infra/pool/guests/vm/100", kind: "project"},
    {path: "/p/Personal/app", kind: "project"},
    {path: "/p/Personal/application", kind: "project"},
  ];
  assert.deepEqual(outline(projectTree(verdicts)), [
    "project /p/Personal/app",
    "project /p/Personal/application",
    "project /p/Personal/infra",
    "  project /p/Personal/infra/pool/guests/vm/100",
    "  project /p/Personal/infra/pool/guests/vm/101",
    "project /p/hass",
    "  project /p/hass/distrib/card",
  ]);
});

test("worktrees and submodules hang under the repository they belong to, wherever they live", () => {
  const verdicts: Verdict[] = [
    {path: "/p/Personal/bb-main", kind: "project"},
    {path: "/p/Personal/bb-main/.worktrees/x", kind: "worktree", parent: "/p/Personal/bb-main"},
    {path: "/p/Personal/agent/worktrees/w", kind: "worktree", parent: "/p/Personal/agent"},
    {path: "/p/Personal/agent", kind: "project"},
    {path: "/p/Work/gr/pkg", kind: "project"},
    {path: "/p/Work/gr/pkg/vendor-sub", kind: "submodule", parent: "/p/Work/gr/pkg"},
    {path: "/p/Personal/bb-main/.worktrees/x/nested", kind: "project"},
  ];
  assert.deepEqual(outline(projectTree(verdicts)), [
    "project /p/Personal/agent",
    "  worktree /p/Personal/agent/worktrees/w",
    "project /p/Personal/bb-main",
    "  worktree /p/Personal/bb-main/.worktrees/x",
    "    project /p/Personal/bb-main/.worktrees/x/nested",
    "project /p/Work/gr/pkg",
    "  submodule /p/Work/gr/pkg/vendor-sub",
  ]);
});

test("a worktree whose repository is outside the folder stays at the top, skipped folders are left out", () => {
  const verdicts: Verdict[] = [
    {path: "/p/copilot/w", kind: "worktree", parent: "/elsewhere/repo"},
    {path: "/p/lim/references/r", kind: "skipped", reason: "excluded"},
  ];
  assert.deepEqual(outline(projectTree(verdicts)), ["worktree /p/copilot/w"]);
});

test("the tree passes its wire schema", async () => {
  const { projectNode } = await import("../src/core/catalog/project-tree.ts");
  const tree = projectTree([{path: "/p/a", kind: "project"}, {path: "/p/a/b", kind: "project"}]);
  assert.deepEqual(projectNode.array().parse(tree), tree);
  assert.equal(projectNode.safeParse({path: "/p/a", kind: "skipped", children: []}).success, false);
});
