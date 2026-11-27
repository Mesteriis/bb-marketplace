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

test("a copy's threads are counted, open and all", () => {
  const {store, thread} = setup();
  thread();
  assert.deepEqual(store.counts("copy_1"), {total: 1, open: 1});
});

test("a Viewed mark is kept per session and file at the change it was made at, and cleared on request", () => {
  const {store, session} = setup();
  store.setViewed(session.id, "a.ts", "r1");
  store.setViewed(session.id, "b.ts", "r2");
  store.setViewed(session.id, "a.ts", "r3");
  assert.deepEqual(Object.fromEntries(store.viewed(session.id)), {"a.ts": "r3", "b.ts": "r2"});
  store.setViewed(session.id, "b.ts", null);
  assert.deepEqual(Object.fromEntries(store.viewed(session.id)), {"a.ts": "r3"});
  assert.deepEqual(Object.fromEntries(store.viewed(store.session("copy_1", "staged").id)), {});
  assert.equal(store.clearSession(session.id), 0);
  assert.deepEqual(Object.fromEntries(store.viewed(session.id)), {"a.ts": "r3"});
});

test("a tab's kept view state is replaced only by one saved later", () => {
  const {store, session} = setup();
  assert.equal(store.viewState("thread:t1", session.id), null);
  assert.equal(store.saveViewState("thread:t1", session.id, 10, "{\"a\":1}"), true);
  assert.equal(store.saveViewState("thread:t1", session.id, 5, "{\"a\":0}"), false);
  assert.equal(store.saveViewState("thread:t1", session.id, 12, "{\"a\":2}"), true);
  assert.equal(store.viewState("thread:t1", session.id), "{\"a\":2}");
  assert.equal(store.viewState("thread:t2", session.id), null);
});

test("the Reviews page lists sessions with threads, newest first, and a session is deleted with all of it", () => {
  const {store, session, thread, tick} = setup();
  thread();
  tick(100);
  const other = store.session("copy_2", "staged");
  const second = store.createThread({sessionId: other.id, filePath: "b.ts", side: null, startLine: 0, endLine: 0, severity: null, anchorContent: null, body: "x"});
  store.setStatus(second.id, "resolved");
  store.session("copy_3", "uncommitted");
  assert.deepEqual(store.summaries().map(row => [row.copyId, row.targetKey, row.open, row.total]), [["copy_2", "staged", 0, 1], ["copy_1", "uncommitted", 1, 1]]);
  store.setViewed(session.id, "a.ts", "r");
  store.deleteSession(session.id);
  assert.equal(store.sessionById(session.id), null);
  assert.deepEqual(store.summaries().map(row => row.copyId), ["copy_2"]);
});

test("a pull request's threads are mirrored with the forge's comments, and an agent's answer there is a draft that leaves the status", () => {
  const {store} = setup();
  const session = store.session("forge:acc", "pr:o/r#7");
  const forge = {filePath: "a.ts", side: "new" as const, startLine: 3, endLine: 4, resolved: false,
    comments: [{author: "alice", body: "Why this?"}, {author: "bob", body: "Agreed."}]};
  const id = store.mirrorThread(session.id, "PRRT_1", forge);
  assert.equal(store.mirrorThread(session.id, "PRRT_1", {...forge, comments: [{author: "alice", body: "Why this, really?"}]}), id);
  store.recordSend(session.id, "thr_a", [id], "");
  assert.notEqual(store.answerAsAgent({threadId: id, callerThreadId: "thr_a", ackBefore: null, authorName: "Codex", body: "Fixed in 1a2b.", status: "resolved"}), null);
  const thread = store.thread(id)!;
  assert.deepEqual([thread.status, thread.comments.map(comment => [comment.authorName, comment.body, comment.draft ?? null])],
    ["open", [["alice", "Why this, really?", null], ["Codex", "Fixed in 1a2b.", "resolve"]]]);
  store.mirrorThread(session.id, "PRRT_1", forge);
  assert.deepEqual(store.drafts(session.id).map(row => [row.externalId, row.draft, row.body]), [["PRRT_1", "resolve", "Fixed in 1a2b."]]);
  const draftId = store.drafts(session.id)[0].commentId;
  store.editDraft(draftId, "Fixed in 1a2b3c.");
  assert.equal(store.drafts(session.id)[0].body, "Fixed in 1a2b3c.");
  store.dropDraft(draftId);
  assert.deepEqual(store.drafts(session.id), []);
});
