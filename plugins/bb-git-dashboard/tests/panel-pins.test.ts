import assert from "node:assert/strict";
import { test } from "node:test";
import { pullPin, samePull } from "../src/core/panel/pins.ts";

test("a pinned pull request's params are read as account, repository path or id, and number", () => {
  assert.deepEqual(pullPin({accountId: "acc_1", repo: "team/app", number: 7}), {accountId: "acc_1", repo: "team/app", repoId: null, number: 7});
  assert.deepEqual(pullPin({accountId: "acc_1", repoId: "991", number: 7}), {accountId: "acc_1", repo: null, repoId: "991", number: 7});
  assert.equal(pullPin({accountId: "acc_1", number: 7}), null);
  assert.equal(pullPin({repo: "team/app", number: 7}), null);
  assert.equal(pullPin({accountId: "acc_1", repo: "team/app", number: "7"}), null);
  assert.equal(pullPin(null), null);
  assert.equal(pullPin(["acc_1"]), null);
});

test("two pins are one pull request when account, repository and number agree; the path is compared without case", () => {
  const made = {accountId: "acc_1", repo: "Team/App", repoId: null, number: 7};
  assert.equal(samePull(made, {accountId: "acc_1", repo: "team/app", repoId: "991", number: 7}), true);
  assert.equal(samePull({accountId: "acc_1", repo: null, repoId: "991", number: 7}, {accountId: "acc_1", repo: null, repoId: "991", number: 7}), true);
  assert.equal(samePull(made, {accountId: "acc_2", repo: "team/app", repoId: null, number: 7}), false);
  assert.equal(samePull(made, {accountId: "acc_1", repo: "team/app", repoId: null, number: 8}), false);
  assert.equal(samePull(made, {accountId: "acc_1", repo: "team/other", repoId: null, number: 7}), false);
  // An old pin with the id only and a new one with the path only cannot be told apart unread: not the same until resolved.
  assert.equal(samePull(made, {accountId: "acc_1", repo: null, repoId: "991", number: 7}), false);
});
