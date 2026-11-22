import { expect, it } from "vitest";
import { unifiedPatch } from "../../../src/core/diff/unified-patch.ts";

it.each([
  ["same\n", "same\n", ""],
  ["", "a\n", "@@ -0,0 +1,1 @@\n+a\n"],
  ["a\n", "", "@@ -1,1 +0,0 @@\n-a\n"],
  ["a", "a\n", "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n"],
  ["one\r\ntwo\nthree\nfour\n", "1\r\ntwo\nthree\n4\n", "@@ -1,4 +1,4 @@\n-one\r\n+1\r\n two\n three\n-four\n+4\n"],
  ["a\nb\nc\nd\ne\nf\ng\nh\ni\n", "A\nb\nc\nd\ne\nf\ng\nh\nI\n", "@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n@@ -6,4 +6,4 @@\n f\n g\n h\n-i\n+I\n"],
])("produces a one-file hunk body for %j → %j", (before, after, patch) => {
  expect(unifiedPatch(before, after)).toBe(patch);
});
