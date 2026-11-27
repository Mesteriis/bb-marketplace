import assert from "node:assert/strict";
import { test } from "node:test";
import { ownComments, type PrDetail } from "../src/core/pulls/detail.ts";

const comment = (id: string, author: string) => ({id, canDelete: false, author, avatarUrl: null, body: "b", createdAt: "", url: ""});
test("the viewer may delete their own comments with an id, nobody else's and never the description", () => {
  const detail = {viewer: "me", timeline: [{...comment("", "me"), reviewState: null}, {...comment("1", "me"), reviewState: null}, {...comment("2", "ann"), reviewState: null}],
    threads: [{id: "T", comments: [comment("3", "ann"), comment("4", "me")]}]} as unknown as PrDetail;
  const own = ownComments(detail);
  assert.deepEqual(own.timeline.map(entry => entry.canDelete), [false, true, false]);
  assert.deepEqual(own.threads[0].comments.map(entry => entry.canDelete), [false, true]);
  assert.deepEqual(ownComments({...detail, viewer: ""}).timeline.map(entry => entry.canDelete), [false, false, false]);
});
