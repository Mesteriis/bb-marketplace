import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch, splitIndexes } from "../src/core/pulls/diff.ts";

test("side by side pairs each removed run with the added run after it, by row index", () => {
  const rows = parsePatch("@@ -1,4 +1,3 @@\n a\n-b\n-c\n+B\n d\n-e\n@@ -9 +8,2 @@\n x\n+y");
  assert.deepEqual(splitIndexes(rows), [
    {kind: "hunk", index: 0},
    {kind: "pair", old: 1, new: 1},
    {kind: "pair", old: 2, new: 4},
    {kind: "pair", old: 3, new: null},
    {kind: "pair", old: 5, new: 5},
    {kind: "pair", old: 6, new: null},
    {kind: "hunk", index: 7},
    {kind: "pair", old: 8, new: 8},
    {kind: "pair", old: null, new: 9},
  ]);
});
