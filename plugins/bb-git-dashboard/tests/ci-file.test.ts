import assert from "node:assert/strict";
import { test } from "node:test";
import { BranchLeft, prepareCiFile, publishCiFile, type CiFileAction } from "../src/adapters/bb/ci-file.ts";
import type { NewFile, Provider, PullMutation, Repo } from "../src/core/providers.ts";

const base = "b".repeat(40);
const made = "c".repeat(40);
const repo: Repo = {id: "1", accountId: "a", project: "owner", name: "app", path: "owner/app", clone: "https://git.example.org/owner/app.git", branch: "main", canPush: true};
const action: CiFileAction = {kind: "ciFile", copyId: "copy", template: "builtin:node-github", path: ".github/workflows/ci.yml", content: "name: CI\non: push\n",
  branch: "ci/node", title: "Add CI", body: "Body"};

/** A forge with branch heads, recording writes; `fail` makes one write throw. */
function forge(heads: Record<string, string>, fail: {create?: Error; pull?: Error} = {}) {
  const writes: unknown[] = [];
  const api = {
    async branch(_: Repo, name: string) { if (!heads[name]) throw new Error("NO_REMOTE_BRANCH"); return heads[name]; },
    async createFile(_: Repo, change: NewFile) { writes.push(["file", change]); if (fail.create) throw fail.create; heads[change.branch] = made; return made; },
    async mutate(_: Repo, mutation: PullMutation) { writes.push(["pull", mutation]); if (fail.pull) throw fail.pull; return {number: 7, outcome: "completed" as const}; },
  } as unknown as Provider;
  return {api, writes};
}

test("prepare reads the default branch's head and names the file, base and new branch", async () => {
  const {api, writes} = forge({main: base});
  assert.deepEqual(await prepareCiFile(api, repo, action), {base, lines: ["Template · builtin:node-github", ".github/workflows/ci.yml · 2 lines",
    "owner/app:main @ " + base, "New branch · ci/node", "Add CI"]});
  assert.deepEqual(writes, []);
});

test("the new branch must be new: the default branch or an existing one is refused before anything is written", async () => {
  await assert.rejects(prepareCiFile(forge({main: base}).api, repo, {...action, branch: "main"}), {message: "BRANCH_EXISTS"});
  await assert.rejects(prepareCiFile(forge({main: base, "ci/node": base}).api, repo, action), {message: "BRANCH_EXISTS"});
  const {api, writes} = forge({main: base, "ci/node": "d".repeat(40)});
  await assert.rejects(publishCiFile(api, repo, action, base), {message: "BRANCH_EXISTS"});
  assert.deepEqual(writes, []);
  await assert.rejects(prepareCiFile(forge({main: base}).api, {...repo, canPush: false}, action), {message: "PROVIDER_DENIED"});
  await assert.rejects(prepareCiFile(forge({main: base}).api, {...repo, branch: null}, action), {message: "NO_REMOTE_BRANCH"});
});

test("publish writes the file at the base it showed, then opens the pull request of the new commit", async () => {
  const {api, writes} = forge({main: base});
  assert.deepEqual(await publishCiFile(api, repo, action, base), {status: "completed", pullNumber: 7, notes: []});
  assert.deepEqual(writes, [
    ["file", {branch: "ci/node", base, baseBranch: "main", path: ".github/workflows/ci.yml", content: "name: CI\non: push\n", message: "Add CI"}],
    ["pull", {kind: "create", head: "ci/node", base: "main", expected: made, title: "Add CI", body: "Body"}],
  ]);
});

test("a default branch that moved since the preview stops publish before any write", async () => {
  const {api, writes} = forge({main: "e".repeat(40)});
  await assert.rejects(publishCiFile(api, repo, action, base), {message: "STALE_HEAD"});
  assert.deepEqual(writes, []);
});

test("a branch left behind is named: the file write failed after the branch was made, or the pull request failed", async () => {
  const left = forge({main: base}, {create: new BranchLeft("PROVIDER_DENIED", null)});
  assert.deepEqual(await publishCiFile(left.api, repo, action, base), {status: "failed", code: "PROVIDER_DENIED",
    notes: ["Branch ci/node was created without the file; delete it on the forge before trying again."]});
  const moved = forge({main: base}, {create: new BranchLeft("STALE_HEAD", made)});
  assert.deepEqual(await publishCiFile(moved.api, repo, action, base), {status: "failed", code: "STALE_HEAD",
    notes: ["Branch ci/node was created at " + made + "; check it, then open the pull request or delete the branch on the forge."]});
  const noPull = forge({main: base}, {pull: new Error("OUTCOME_UNKNOWN")});
  assert.deepEqual(await publishCiFile(noPull.api, repo, action, base), {status: "unknown", code: "OUTCOME_UNKNOWN",
    notes: ["Branch ci/node was created at " + made + "; check it, then open the pull request or delete the branch on the forge."]});
  // A failure before any branch exists is an ordinary failure.
  await assert.rejects(publishCiFile(forge({main: base}, {create: new Error("PROVIDER_REJECTED")}).api, repo, action, base), {message: "PROVIDER_REJECTED"});
});
