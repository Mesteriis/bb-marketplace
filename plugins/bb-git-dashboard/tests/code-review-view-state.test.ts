import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_VIEW_STATE, orphanDrafts, readViewState } from "../src/core/code-review/view-state.ts";

test("a kept state reads back, and anything malformed counts as nothing kept", () => {
  const state = {savedAt: 5, drafts: {"line:a.ts": {body: "Why?", severity: "nit", range: {side: "new", start: 2, end: 3}}}, folds: {"b.ts": true}, scroll: 120};
  assert.deepEqual(readViewState(JSON.stringify(state)), state);
  assert.deepEqual(readViewState(JSON.stringify({...state, scroll: -1})), EMPTY_VIEW_STATE);
  assert.deepEqual(readViewState(JSON.stringify({...state, extra: 1})), EMPTY_VIEW_STATE);
  assert.deepEqual(readViewState("{"), EMPTY_VIEW_STATE);
  assert.deepEqual(readViewState(null), EMPTY_VIEW_STATE);
});

test("drafts on files the view does not show are offered apart; empty ones are not", () => {
  const state = {savedAt: 1, scroll: 0, folds: {}, drafts: {
    general: {body: "All good", severity: null}, "file:gone.ts": {body: "Lost?", severity: null}, "line:a.ts": {body: "Here", severity: null},
    "line:old.ts": {body: "  ", severity: null}, "reply:abc": {body: "Reply", severity: null}}};
  assert.deepEqual(orphanDrafts(state, new Set(["a.ts"])), [{key: "file:gone.ts", path: "gone.ts", draft: {body: "Lost?", severity: null}}]);
});
