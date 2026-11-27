import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictCount, hasMarkers, lineEnds, mergeMessage, parseConflicts, resolveConflicts } from "../src/core/merge/conflicts.ts";

const zdiff3 = [
  "head",
  "<<<<<<< ours",
  "const a = 1;",
  "const b = 2;",
  "||||||| base",
  "const a = 0;",
  "=======",
  "const a = 3;",
  ">>>>>>> theirs",
  "middle",
  "<<<<<<< HEAD",
  "x",
  "=======",
  "y",
  ">>>>>>> feature",
  "tail",
  "",
].join("\n");

test("conflict blocks with and without a base are read between plain text", () => {
  const parsed = parseConflicts(zdiff3);
  assert.deepEqual(parsed, {finalNewline: true, segments: [
    {kind: "text", lines: ["head"]},
    {kind: "conflict", ours: ["const a = 1;", "const b = 2;"], base: ["const a = 0;"], theirs: ["const a = 3;"], labels: {ours: "ours", base: "base", theirs: "theirs"}},
    {kind: "text", lines: ["middle"]},
    {kind: "conflict", ours: ["x"], base: null, theirs: ["y"], labels: {ours: "HEAD", base: "", theirs: "feature"}},
    {kind: "text", lines: ["tail"]},
  ]});
  assert.equal(conflictCount(parsed), 2);
  assert.equal(hasMarkers(zdiff3), true);
});

test("each choice builds its text; an unanswered conflict leaves nothing to save", () => {
  const parsed = parseConflicts(zdiff3);
  assert.equal(resolveConflicts(parsed, [{kind: "ours"}, {kind: "theirs"}]),
    "head\nconst a = 1;\nconst b = 2;\nmiddle\ny\ntail\n");
  assert.equal(resolveConflicts(parsed, [{kind: "base"}, {kind: "both", first: "theirs"}]),
    "head\nconst a = 0;\nmiddle\ny\nx\ntail\n");
  assert.equal(resolveConflicts(parsed, [{kind: "lines", ours: [1], theirs: [0], first: "ours"}, {kind: "text", text: "z\nzz"}]),
    "head\nconst b = 2;\nconst a = 3;\nmiddle\nz\nzz\ntail\n");
  assert.equal(resolveConflicts(parsed, [{kind: "ours"}, null]), null);
  assert.equal(resolveConflicts(parsed, [{kind: "base"}, {kind: "base"}]), null, "the second conflict has no base");
});

test("CRLF lines keep their endings, a file without a final newline stays so", () => {
  const text = "a\r\n<<<<<<< ours\r\nb\r\n=======\r\nc\r\n>>>>>>> theirs\r\nd";
  const parsed = parseConflicts(text);
  assert.equal(parsed.finalNewline, false);
  assert.equal(resolveConflicts(parsed, [{kind: "theirs"}]), "a\r\nc\r\nd");
});

test("text that only looks like a marker is not one; an unclosed block is not a conflict", () => {
  const text = "<<<<<<<< eight\n======= not a separator here\nplain\n";
  assert.deepEqual(parseConflicts(text).segments, [{kind: "text", lines: ["<<<<<<<< eight", "======= not a separator here", "plain"]}]);
  assert.equal(hasMarkers(text), false);
  const unclosed = "<<<<<<< ours\na\n=======\nb\n";
  assert.equal(conflictCount(parseConflicts(unclosed)), 0);
  assert.equal(hasMarkers(unclosed), true, "a stray marker still blocks saving as resolved");
});

test("a merge commit is named after what it brings in, and into which branch unless that is main or master", () => {
  assert.equal(mergeMessage("refs/heads/feature", "main"), "Merge branch 'feature'");
  assert.equal(mergeMessage("refs/remotes/origin/feature", "master"), "Merge remote-tracking branch 'origin/feature'");
  assert.equal(mergeMessage("refs/heads/main", "feature"), "Merge branch 'main' into feature");
  assert.equal(mergeMessage("refs/heads/main", null), "Merge branch 'main'");
});

test("a heading underlined with seven = signs is text, not a leftover conflict", () => {
  assert.equal(hasMarkers("Title\n=======\n\nBody\n"), false);
  assert.equal(hasMarkers("a\n>>>>>>> theirs\n"), true);
});

test("a result edited by hand in a CRLF file goes back with CRLF line ends", () => {
  assert.equal(lineEnds("a\nb\n", "x\r\ny\r\n"), "a\r\nb\r\n");
  assert.equal(lineEnds("a\r\nb\n", "x\r\ny\r\n"), "a\r\nb\r\n");
  assert.equal(lineEnds("a\nb\n", "x\ny\n"), "a\nb\n");
  assert.equal(lineEnds("a\nb\n", null), "a\nb\n");
});
