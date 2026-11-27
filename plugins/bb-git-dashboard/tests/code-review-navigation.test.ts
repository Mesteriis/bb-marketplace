import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewDiffFile } from "../src/core/code-review/diff.ts";
import type { ReviewThread } from "../src/core/code-review/model.ts";
import { commentOrder, findMatches, goToItems, step } from "../src/ui/code-review/navigation.ts";

const file = (path: string, patch: string | null): ReviewDiffFile => ({path, previousPath: null, changeKind: "modified", additions: 1, deletions: 1, binary: false, untracked: false, patch, tooLarge: false});
const files = [file("a.ts", "@@ -1,2 +1,2 @@\n Keep\n-old Value\n+new value\n"), file("b.ts", "@@ -1 +1 @@\n-value\n+VALUE\n"), file("c.bin", null)];
const thread = (id: string, filePath: string, startLine: number, status: ReviewThread["status"] = "open", body = "Why?"): ReviewThread => ({id, sessionId: "s", filePath,
  side: startLine ? "new" : null, startLine, endLine: startLine, status, severity: null, anchorContent: null, createdAt: 1, updatedAt: 1,
  comments: [{id: "c" + id, authorType: "user", authorName: "You", body, createdAt: 1, editedAt: null}], delivery: null});

test("Find matches diff lines, not hunk headers, with or without case", () => {
  assert.deepEqual(findMatches(files, "value", false), [{path: "a.ts", row: 2}, {path: "a.ts", row: 3}, {path: "b.ts", row: 1}, {path: "b.ts", row: 2}]);
  assert.deepEqual(findMatches(files, "Value", true), [{path: "a.ts", row: 2}]);
  assert.deepEqual(findMatches(files, "@@", false), []);
  assert.deepEqual(findMatches(files, "", false), []);
});

test("stepping goes round both ways and starts at the near end", () => {
  assert.deepEqual([step(3, -1, 1), step(3, -1, -1), step(3, 2, 1), step(3, 0, -1), step(0, -1, 1)], [0, 2, 0, 2, -1]);
});

test("comments are stepped through as shown: whole diff first, then by file and line, open ones only", () => {
  const order = commentOrder(files, [thread("t1", "b.ts", 1), thread("t2", "a.ts", 3), thread("t3", "__general__", 0), thread("t4", "a.ts", 1), thread("t5", "a.ts", 2, "resolved")]);
  assert.deepEqual(order, ["t3", "t4", "t2", "t1"]);
});

test("Go to filters files, comments and views by every word", () => {
  const items = goToItems(files, [thread("t1", "b.ts", 1, "open", "Rename this value")], [{kind: "staged", label: "Staged"}], "b rename");
  assert.deepEqual(items.map(item => item.label), ["b.ts:1 (new side) — Rename this value"]);
  assert.deepEqual(goToItems(files, [], [{kind: "staged", label: "Staged"}], "stag").map(item => item.kind), ["view"]);
  assert.equal(goToItems(files, [], [], "").length, 3);
});
