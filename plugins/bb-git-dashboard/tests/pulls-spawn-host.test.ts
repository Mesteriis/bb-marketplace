import test from "node:test";
import assert from "node:assert/strict";
import { spawnHost } from "../src/core/pulls/agent-target.ts";

test("a new agent thread starts where the project's working copy is, else on a git environment of it", () => {
  const environments = [{hostId: "laptop", isGitRepo: false}, {hostId: "studio", isGitRepo: true}];
  assert.equal(spawnHost({sources: [{hostId: "mini"}, {hostId: "laptop"}]}, environments), "mini");
  assert.equal(spawnHost({sources: []}, environments), "studio");
  assert.equal(spawnHost(undefined, [{hostId: "laptop", isWorktree: true}]), "laptop");
  assert.equal(spawnHost({sources: []}, [{hostId: "laptop"}]), null);
});
