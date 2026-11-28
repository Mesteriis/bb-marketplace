import assert from "node:assert/strict";
import { test } from "node:test";
import { firstTime, targetScreen } from "../src/core/panel/target.ts";

test("a target names the panel's screen; a CI target with a run opens that run", () => {
  assert.deepEqual(targetScreen({screen: "review"}), {kind: "review"});
  assert.deepEqual(targetScreen({screen: "ci", runId: "42"}), {kind: "ci", view: {kind: "run", runId: "42"}});
  assert.deepEqual(targetScreen({screen: "ci"}), {kind: "ci", view: {kind: "runs"}});
  assert.deepEqual(targetScreen({screen: "summary"}), {kind: "summary"});
});

test("a target's command runs once per target, however often the tab mounts again", () => {
  const handled = new Map<string, number>();
  assert.equal(firstTime(handled, "thr_a", 1), true);
  assert.equal(firstTime(handled, "thr_a", 1), false);
  assert.equal(firstTime(handled, "thr_b", 1), true);
  assert.equal(firstTime(handled, "thr_a", 2), true);
  assert.equal(firstTime(handled, "thr_a", 2), false);
});
