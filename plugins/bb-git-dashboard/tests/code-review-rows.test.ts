import test from "node:test";
import assert from "node:assert/strict";
import { displayRows } from "../src/core/code-review/rows.ts";

test("a local patch shows its hunks and lines with both numbers, skipping the file headers", () => {
  const patch = ["diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@ fn", " one", "-two", "+TWO", " three",
    "@@ -10 +10,2 @@", "-ten", "+TEN", "+eleven", "\\ No newline at end of file", ""].join("\n");
  assert.deepEqual(displayRows(patch), [
    {kind: "hunk", text: "@@ -1,3 +1,3 @@ fn", oldLine: null, newLine: null},
    {kind: "context", text: "one", oldLine: 1, newLine: 1},
    {kind: "deletion", text: "two", oldLine: 2, newLine: null},
    {kind: "addition", text: "TWO", oldLine: null, newLine: 2},
    {kind: "context", text: "three", oldLine: 3, newLine: 3},
    {kind: "hunk", text: "@@ -10 +10,2 @@", oldLine: null, newLine: null},
    {kind: "deletion", text: "ten", oldLine: 10, newLine: null},
    {kind: "addition", text: "TEN", oldLine: null, newLine: 10},
    {kind: "addition", text: "eleven", oldLine: null, newLine: 11},
  ]);
});

test("a removed line starting with dashes inside a hunk is a line, not a header", () => {
  assert.deepEqual(displayRows("@@ -1 +0,0 @@\n---- gone\n").map(row => [row.kind, row.text]), [["hunk", "@@ -1 +0,0 @@"], ["deletion", "--- gone"]]);
});

test("split rows put each removed run beside the added run after it, and context on both sides", async () => {
  const {splitRows} = await import("../src/core/code-review/rows.ts");
  const rows = displayRows(["@@ -1,4 +1,4 @@", " keep", "-a", "-b", "+A", " end", "+tail", ""].join("\n").replace("@@ -1,4 +1,4 @@", "@@ -1,4 +1,4 @@"));
  const shape = splitRows(rows).map(row => row.kind === "hunk" ? "hunk" : (row.old?.text ?? "·") + "|" + (row.new?.text ?? "·"));
  assert.deepEqual(shape, ["hunk", "keep|keep", "a|A", "b|·", "end|end", "·|tail"]);
});

test("a whole file reads as context lines that comments can be placed on", async () => {
  const {wholeFileEntry} = await import("../src/core/code-review/diff.ts");
  const {parsePatchLines, linesText} = await import("../src/core/code-review/patch-lines.ts");
  const entry = wholeFileEntry("a.md", "one\ntwo\nthree\n");
  assert.equal(entry.patch, "@@ -1,3 +1,3 @@\n one\n two\n three\n");
  assert.deepEqual(displayRows(entry.patch!).map(row => [row.kind, row.newLine]), [["hunk", null], ["context", 1], ["context", 2], ["context", 3]]);
  assert.equal(linesText(parsePatchLines(entry.patch!), "new", 2, 3), "two\nthree");
  assert.equal(wholeFileEntry("e.txt", "").patch, null);
  assert.equal(wholeFileEntry("n.txt", "no newline").patch, "@@ -1,1 +1,1 @@\n no newline\n");
});
