import test from "node:test";
import assert from "node:assert/strict";
import { threadFromPath } from "../src/core/threadRoute.ts";

test("a central TreadChat route identifies exactly one BB thread", () => {
  assert.equal(threadFromPath("thr_example123"), "thr_example123");
  assert.equal(threadFromPath("%74hr_example123"), "thr_example123");
  assert.equal(threadFromPath(""), null);
  assert.equal(threadFromPath("thr_a/thr_b"), null);
  assert.equal(threadFromPath("thr_a%2Fthr_b"), null);
  assert.equal(threadFromPath("%zz"), null);
});
