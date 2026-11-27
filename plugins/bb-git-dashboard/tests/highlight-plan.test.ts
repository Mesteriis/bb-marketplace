import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightPlan, languageOf } from "../src/core/highlight/plan.ts";

test("a file's language comes from its name or extension; an unknown one is not highlighted", () => {
  assert.deepEqual(["src/a.ts", "b.TSX", "x/y.py", "Dockerfile", "deploy/Dockerfile.prod", "Makefile", "a.yml", "c.h", "notes.txt", "LICENSE", ".env"].map(languageOf),
    ["typescript", "tsx", "python", "dockerfile", "dockerfile", "make", "yaml", "c", null, null, null]);
});

test("each side of the diff is one block of code, and each row knows its line in it", () => {
  const rows = [
    {kind: "hunk", text: "@@ -1,2 +1,2 @@"},
    {kind: "context", text: "const a = 1;"},
    {kind: "deletion", text: "let b = 2;"},
    {kind: "addition", text: "const b = 2;"},
    {kind: "hunk", text: "@@ -9 +9 @@"},
    {kind: "context", text: "}"},
  ];
  assert.deepEqual(highlightPlan(rows), {
    old: "const a = 1;\nlet b = 2;\n}",
    new: "const a = 1;\nconst b = 2;\n}",
    at: [null, {old: 0, new: 0}, {old: 1, new: null}, {old: null, new: 1}, null, {old: 2, new: 2}],
  });
});

test("the pull request's row kinds read the same way", () => {
  const plan = highlightPlan([{kind: "ctx", text: "a"}, {kind: "del", text: "b"}, {kind: "add", text: "c"}]);
  assert.deepEqual([plan.old, plan.new, plan.at], ["a\nb", "a\nc", [{old: 0, new: 0}, {old: 1, new: null}, {old: null, new: 1}]]);
});
