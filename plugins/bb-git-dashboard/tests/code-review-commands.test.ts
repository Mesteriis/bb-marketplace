import test from "node:test";
import assert from "node:assert/strict";
import { dispatchReviewCommand, takeReviewCommands } from "../src/ui/code-review/commands.ts";

test("a command reaches the showing Review, or waits a few seconds for the one about to show", () => {
  const got: string[] = [];
  const stop = takeReviewCommands("thr_1", command => got.push("a:" + command));
  dispatchReviewCommand("thr_1", "reload");
  stop();
  dispatchReviewCommand("thr_1", "find", 1_000);
  takeReviewCommands("thr_1", command => got.push("b:" + command), () => 3_000)();
  dispatchReviewCommand("thr_1", "clear", 1_000);
  takeReviewCommands("thr_1", command => got.push("c:" + command), () => 7_000)();
  dispatchReviewCommand("thr_2", "send");
  assert.deepEqual(got, ["a:reload", "b:find"]);
});
