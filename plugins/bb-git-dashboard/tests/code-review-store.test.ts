import test from "node:test";
import assert from "node:assert/strict";
import { ReviewStore } from "../src/adapters/bb/review-store.ts";
import { memoryDb } from "./review-db.ts";

function setup() {
  let now = 1_000;
  const store = new ReviewStore(memoryDb(), () => now);
  const session = store.session("copy_1", "uncommitted");
  const thread = (body = "Why?") => store.createThread({sessionId: session.id, filePath: "a.ts", side: "new", startLine: 2, endLine: 3,
    severity: "must-fix", anchorContent: "two\nthree", body});
  return {store, session, thread, tick: (ms = 10) => { now += ms; }};
}

test("a session is one per copy and view, and a thread starts with the owner's comment", () => {
  const {store, session, thread} = setup();
  assert.equal(store.session("copy_1", "uncommitted").id, session.id);
  assert.notEqual(store.session("copy_2", "uncommitted").id, session.id);
  const made = thread();
  assert.match(made.id, /^[0-9a-f]{12}$/);
  assert.deepEqual([made.status, made.severity, made.anchorContent, made.delivery], ["open", "must-fix", "two\nthree", null]);
  assert.deepEqual(made.comments.map(comment => [comment.authorType, comment.authorName, comment.body]), [["user", "You", "Why?"]]);
});

test("deleting a thread's last comment deletes the thread", () => {
  const {store, thread} = setup();
  const made = thread();
  const second = store.addComment(made.id, "More.");
  store.deleteComment(made.comments[0].id);
  assert.deepEqual(store.thread(made.id)!.comments.map(comment => comment.body), ["More."]);
  store.deleteComment(second.id);
  assert.equal(store.thread(made.id), null);
});

test("an agent answers only threads sent to its own thread, and its answer acknowledges the send", () => {
  const {store, session, thread, tick} = setup();
  const made = thread();
  assert.equal(store.answerAsAgent({threadId: made.id, callerThreadId: "thr_a", ackBefore: null, authorName: "Claude Code", body: "Fixed.", status: "resolved"}), null);
  const send = store.recordSend(session.id, "thr_a", [made.id], "");
  assert.equal(store.thread(made.id)!.delivery?.state, "sent");
  assert.equal(store.answerAsAgent({threadId: made.id, callerThreadId: "thr_b", ackBefore: null, authorName: "X", body: "Mine.", status: null}), null);
  tick();
  assert.ok(store.answerAsAgent({threadId: made.id, callerThreadId: "thr_a", ackBefore: send.createdAt + 5, authorName: "Claude Code", body: "Fixed.", status: "resolved"}));
  const after = store.thread(made.id)!;
  assert.deepEqual([after.status, after.delivery?.state, after.comments.at(-1)?.authorType, after.comments.at(-1)?.authorName], ["resolved", "answered", "agent", "Claude Code"]);
});

test("an answer from a turn that started before the send does not acknowledge it", () => {
  const {store, session, thread} = setup();
  const made = thread();
  const send = store.recordSend(session.id, "thr_a", [made.id], "");
  store.answerAsAgent({threadId: made.id, callerThreadId: "thr_a", ackBefore: send.createdAt - 1, authorName: "A", body: "Earlier.", status: null});
  assert.equal(store.thread(made.id)!.delivery?.state, "sent");
});

test("a failed send puts each thread back where it was, whichever of two sends fails", () => {
  const {store, session, thread, tick} = setup();
  const made = thread();
  const first = store.recordSend(session.id, "thr_a", [made.id], "");
  tick();
  const second = store.recordSend(session.id, "thr_b", [made.id], "");
  store.dropSend(first.id);
  assert.equal(store.thread(made.id)!.delivery?.threadId, "thr_b");
  store.dropSend(second.id);
  assert.equal(store.thread(made.id)!.delivery, null);
  const third = store.recordSend(session.id, "thr_a", [made.id], "");
  tick();
  const fourth = store.recordSend(session.id, "thr_b", [made.id], "");
  store.dropSend(fourth.id);
  assert.deepEqual([store.thread(made.id)!.delivery?.threadId, store.thread(made.id)!.delivery?.sendId], ["thr_a", third.id]);
});

test("a thread still waiting when the agent's turn ends is marked no reply, once", () => {
  const {store, session, thread} = setup();
  const made = thread();
  store.recordSend(session.id, "thr_a", [made.id], "");
  const waiting = store.waitingOn("thr_a");
  assert.deepEqual(waiting.map(row => row.threadId), [made.id]);
  assert.equal(store.markNoReply(waiting).length, 1);
  assert.equal(store.markNoReply(waiting).length, 0);
  assert.equal(store.thread(made.id)!.delivery?.state, "no_reply");
});

test("short ids are found by prefix, with LIKE characters taken literally", () => {
  const {store, thread} = setup();
  const made = thread();
  assert.deepEqual(store.threadsByPrefix(made.id.slice(0, 4)), [made.id]);
  assert.deepEqual(store.threadsByPrefix("%"), []);
  assert.deepEqual(store.counts("copy_1"), {total: 1, open: 1});
});
