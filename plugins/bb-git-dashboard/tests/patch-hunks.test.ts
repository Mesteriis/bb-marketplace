import assert from "node:assert/strict";
import { test } from "node:test";
import { patchHunks } from "../src/core/patch.ts";
import { parsePatch } from "../src/core/pulls/diff.ts";

const newFile = "diff --git a/panel-note.txt b/panel-note.txt\nnew file mode 100644\nindex 0000000..04cd1f7\n--- /dev/null\n+++ b/panel-note.txt\n@@ -0,0 +1 @@\n+a line for the panel\n";

test("a new file's patch is one hunk whose one line is added as line 1", () => {
  const hunks = patchHunks(newFile);
  assert.deepEqual(hunks, ["@@ -0,0 +1 @@\n+a line for the panel\n"]);
  assert.deepEqual(parsePatch(hunks[0]!), [
    {kind: "hunk", text: "@@ -0,0 +1 @@", oldLine: null, newLine: null},
    {kind: "add", text: "a line for the panel", oldLine: null, newLine: 1},
  ]);
});

test("a changed file's patch splits at each hunk; a binary or empty patch has none", () => {
  const changed = "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n@@ -10 +10 @@ ctx\n-p\n+q\n";
  assert.deepEqual(patchHunks(changed), ["@@ -1,2 +1,2 @@\n-x\n+y\n z\n", "@@ -10 +10 @@ ctx\n-p\n+q\n"]);
  assert.deepEqual(patchHunks("diff --git a/b.png b/b.png\nnew file mode 100644\nBinary files /dev/null and b/b.png differ\n"), []);
  assert.deepEqual(patchHunks(""), []);
});

test("a patch of two sections (a file whose type changed) keeps the second section's git header out of the first hunk", () => {
  const patch = "diff --git a/x b/x\ndeleted file mode 120000\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n"
    + "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+text\n";
  assert.deepEqual(patchHunks(patch), ["@@ -1 +0,0 @@\n-target\n\\ No newline at end of file\n", "@@ -0,0 +1 @@\n+text\n"]);
});
