import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryOf, localState } from "../src/core/catalog/rows.ts";

test("a project's category is the deepest category folder it lies in, or the projects folder itself", () => {
  const categories = ["", "Personal", "Work", "Work/clients"];
  assert.equal(categoryOf("/home/me/projects", "/home/me/projects/Personal/atlas", categories), "Personal");
  assert.equal(categoryOf("/home/me/projects/", "/home/me/projects/Work/clients/shop", categories), "Work/clients");
  assert.equal(categoryOf("/home/me/projects", "/home/me/projects/loose", categories), "");
  assert.equal(categoryOf("/home/me/projects", "/home/me/projects/Workshop/tool", categories), "");
  assert.equal(categoryOf("/home/me/projects", "/elsewhere/Work/x", categories), "");
});

test("a status answer becomes the row's state: branch, changed files, ahead and behind; a failure keeps its code", () => {
  assert.deepEqual(localState(undefined), {kind: "unknown"});
  assert.deepEqual(localState({ok: false, code: "HOST_UNAVAILABLE", value: null}), {kind: "failed", code: "HOST_UNAVAILABLE"});
  assert.deepEqual(localState({ok: false, code: null, value: null}), {kind: "failed", code: "FAILED"});
  assert.deepEqual(localState({ok: true, code: null, value: {root: "/p", branch: "main", upstream: "origin/main", ahead: 2, behind: 0,
    files: [{path: "a", index: "M", worktree: " "}, {path: "b", index: " ", worktree: "M"}, {path: "c", index: "?", worktree: "?"}]}}),
  {kind: "ok", branch: "main", files: 3, ahead: 2, behind: 0, upstream: true});
  assert.deepEqual(localState({ok: true, code: null, value: {root: "/p", branch: null}}),
    {kind: "ok", branch: null, files: 0, ahead: 0, behind: 0, upstream: false});
});
