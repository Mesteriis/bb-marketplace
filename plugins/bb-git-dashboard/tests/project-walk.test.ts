import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkProjects } from "../src/adapters/bb/project-walk.ts";

test("the walk classifies projects, linked worktrees, submodules and skipped clones", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-walk-")));
  try {
    const dir = (...parts: string[]) => mkdirSync(join(root, ...parts), {recursive: true});
    const file = (path: string, text: string) => writeFileSync(join(root, path), text);
    dir("Personal/app/.git");
    dir("Personal/bb-main/.git/worktrees/x"); dir("Personal/bb-main/.worktrees/x");
    file("Personal/bb-main/.worktrees/x/.git", "gitdir: " + join(root, "Personal/bb-main/.git/worktrees/x") + "\n");
    dir("agent-team/.git/worktrees/w"); dir("agent-team/worktrees/w");
    file("agent-team/worktrees/w/.git", "gitdir: ../../.git/worktrees/w\n");
    dir("infra/.git/modules/m"); dir("infra/m");
    file("infra/m/.git", "gitdir: ../.git/modules/m\n");
    dir("lim/.git"); dir("lim/references/r/.git");
    dir("hass/.git"); dir("hass/distrib/d/.git");
    dir("Work/group/svc/.git"); dir("Work/group/svc/node_modules/pkg/.git");
    dir("odd"); file("odd/.git", "gitdir: /nonexistent/.git/worktrees/z\n");
    dir(".cache/c/.git");
    symlinkSync(join(root, "Personal/app"), join(root, "link"));

    const {verdicts, truncated} = await walkProjects(root, {exclude: ["node_modules", "vendor", "references"], maxDepth: 6});
    assert.equal(truncated, false);
    const rel = (path: string) => path.slice(root.length + 1);
    assert.deepEqual(verdicts.map(verdict => ({...verdict, path: rel(verdict.path), ...("parent" in verdict ? {parent: rel(verdict.parent)} : {})}))
      .sort((left, right) => left.path.localeCompare(right.path)), [
      {path: ".cache/c", kind: "skipped", reason: "hidden"},
      {path: "agent-team", kind: "project"},
      {path: "agent-team/worktrees/w", kind: "worktree", parent: "agent-team"},
      {path: "hass", kind: "project"},
      {path: "hass/distrib/d", kind: "project"},
      {path: "infra", kind: "project"},
      {path: "infra/m", kind: "submodule", parent: "infra"},
      {path: "lim", kind: "project"},
      {path: "lim/references/r", kind: "skipped", reason: "excluded"},
      {path: "odd", kind: "skipped", reason: "broken-gitdir"},
      {path: "Personal/app", kind: "project"},
      {path: "Personal/bb-main", kind: "project"},
      {path: "Personal/bb-main/.worktrees/x", kind: "worktree", parent: "Personal/bb-main"},
      {path: "Work/group/svc", kind: "project"},
      {path: "Work/group/svc/node_modules/pkg", kind: "skipped", reason: "excluded"},
    ]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("the walk stops at the depth limit and tolerates a missing root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-walk-")));
  try {
    mkdirSync(join(root, "a/b/c/.git"), {recursive: true});
    assert.deepEqual((await walkProjects(root, {exclude: [], maxDepth: 2})).verdicts, []);
    assert.equal((await walkProjects(root, {exclude: [], maxDepth: 3})).verdicts.length, 1);
    assert.deepEqual(await walkProjects(join(root, "missing"), {exclude: [], maxDepth: 3}), {verdicts: [], truncated: false});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a walk that reaches its folder limit says so instead of returning a silent partial list", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-walk-")));
  try {
    for (const name of ["a", "b", "c", "d"]) mkdirSync(join(root, name, ".git"), {recursive: true});
    const partial = await walkProjects(root, {exclude: [], maxDepth: 3}, 3);
    assert.equal(partial.truncated, true);
    assert.equal(partial.verdicts.length, 2);
    assert.equal((await walkProjects(root, {exclude: [], maxDepth: 3}, 5)).truncated, false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
