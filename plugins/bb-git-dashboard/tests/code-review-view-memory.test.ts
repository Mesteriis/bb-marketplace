import test from "node:test";
import assert from "node:assert/strict";
import { keepView, NOTHING_KEPT, readView, viewScope } from "../src/core/code-review/view-memory.ts";

const memory = () => { const items = new Map<string, string>(); return {getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, items}; };

test("a picked view and the toggles come back per thread tab or per working copy", () => {
  const storage = memory();
  keepView(storage, viewScope("c1", "thr_1"), {target: {kind: "range", from: "main", to: "HEAD", symmetric: true}, ignoreWhitespace: true, onlyCommented: false, wrap: true, split: true});
  assert.deepEqual(readView(storage, "thread:thr_1"), {target: {kind: "range", from: "main", to: "HEAD", symmetric: true}, ignoreWhitespace: true, onlyCommented: false, wrap: true, split: true});
  assert.deepEqual(readView(storage, viewScope("c1", undefined)), NOTHING_KEPT);
  assert.equal(viewScope("c1", undefined), "copy:c1");
});

test("anything unreadable is forgotten rather than trusted", () => {
  const storage = memory();
  storage.setItem("git-dashboard:review-view:copy:c1", JSON.stringify({target: {kind: "commit", sha: "not hex; rm"}, wrap: "yes"}));
  assert.deepEqual(readView(storage, "copy:c1"), NOTHING_KEPT);
  storage.setItem("git-dashboard:review-view:copy:c2", "{broken");
  assert.deepEqual(readView(storage, "copy:c2"), NOTHING_KEPT);
  assert.deepEqual(readView(undefined, "copy:c1"), NOTHING_KEPT);
  const full = {getItem: () => null, setItem: () => { throw new Error("quota"); }};
  keepView(full, "copy:c1", NOTHING_KEPT);
});
