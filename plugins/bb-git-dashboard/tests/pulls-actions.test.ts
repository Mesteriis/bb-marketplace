import assert from "node:assert/strict";
import { test } from "node:test";
import { describePrAction, prAction } from "../src/core/pulls/actions.ts";

const pr = {number: 7, title: "Add retries", repo: "o/r", headRefName: "retries", baseRefName: "main"};

test("each pull request write says in its preview exactly what will happen", () => {
  assert.deepEqual(describePrAction(pr, {kind: "comment", body: "Looks good"}), ["Comment on o/r #7", "Looks good"]);
  assert.deepEqual(describePrAction(pr, {kind: "lineComment", path: "src/a.ts", line: 12, side: "RIGHT", startLine: 10, body: "Rename"}),
    ["Comment on src/a.ts lines 10–12 of o/r #7", "Rename"]);
  assert.deepEqual(describePrAction(pr, {kind: "review", event: "REQUEST_CHANGES", body: "Needs tests", comments: [
    {path: "src/a.ts", line: 3, side: "LEFT", startLine: null, body: "Why removed?"}]}),
    ["Request changes on o/r #7", "Needs tests", "src/a.ts line 3 (old): Why removed?"]);
  assert.deepEqual(describePrAction(pr, {kind: "merge", method: "squash"}), ["Squash and merge o/r #7: retries into main"]);
  assert.deepEqual(describePrAction(pr, {kind: "state", open: false}), ["Close o/r #7"]);
  assert.deepEqual(describePrAction(pr, {kind: "draft", draft: false}), ["Mark o/r #7 ready for review"]);
  assert.deepEqual(describePrAction(pr, {kind: "resolve", threadId: "T1", resolved: true}), ["Resolve a review thread on o/r #7"]);
  assert.deepEqual(describePrAction(pr, {kind: "editTitle", title: "Add retries to fetch"}), ["Rename o/r #7 to “Add retries to fetch”"]);
});

test("actions are validated: no empty text, sane lines, a bounded review", () => {
  assert.equal(prAction.safeParse({kind: "comment", body: "  "}).success, false);
  assert.equal(prAction.safeParse({kind: "lineComment", path: "../etc/passwd", line: 1, side: "RIGHT", startLine: null, body: "x"}).success, false);
  assert.equal(prAction.safeParse({kind: "lineComment", path: "a.ts", line: 0, side: "RIGHT", startLine: null, body: "x"}).success, false);
  assert.equal(prAction.safeParse({kind: "lineComment", path: "a.ts", line: 3, side: "RIGHT", startLine: 5, body: "x"}).success, false);
  assert.equal(prAction.safeParse({kind: "review", event: "APPROVE", body: "", comments: Array.from({length: 51}, () =>
    ({path: "a.ts", line: 1, side: "RIGHT", startLine: null, body: "x"}))}).success, false);
  assert.equal(prAction.safeParse({kind: "merge", method: "octopus"}).success, false);
  assert.equal(prAction.safeParse({kind: "requestReviewer", reviewer: "a b"}).success, false);
});
