import assert from "node:assert/strict";
import { test } from "node:test";
import { threadFilter } from "../src/core/pulls/detail.ts";
import type { Thread } from "../src/core/pulls/detail.ts";

const thread = (id: string, over: Partial<Thread>) => ({id, isResolved: false, isPending: false, awaitingReply: false, ...over}) as Thread;
const threads = [thread("open-asks", {awaitingReply: true}), thread("open-answered", {}), thread("done", {isResolved: true}), thread("draft", {isPending: true, awaitingReply: true})];

test("on your pull request the open threads waiting on you are counted; drafts of your review are left out", () => {
  assert.deepEqual(threadFilter(threads, "me", "me"), {unresolved: ["open-asks", "open-answered"], resolved: ["done"], waiting: "1 waiting on your reply"});
});

test("on someone else's, the threads the author answered are counted", () => {
  assert.deepEqual(threadFilter(threads, "me", "ann").waiting, "1 answered by ann");
  assert.equal(threadFilter([thread("x", {awaitingReply: true})], "me", "ann").waiting, null);
});
