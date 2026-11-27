import test from "node:test";
import assert from "node:assert/strict";
import { ReviewStore } from "../src/adapters/bb/review-store.ts";
import { pendingRunThread, RunStore } from "../src/adapters/bb/review-run-store.ts";
import { memoryDb } from "./review-db.ts";

function setup() {
  let now = 1_000;
  const db = memoryDb();
  const store = new ReviewStore(db, () => now);
  const runs = new RunStore(db, () => now);
  const session = store.session("copy_1", "uncommitted");
  const start = (kind: "review" | "fix" | "summary" | "explain" = "review") =>
    runs.create({sessionId: session.id, kind, focus: kind === "review" ? "security" : null, providerId: "claude-code", model: "sonnet",
      parentThreadId: "thr_parent", baseline: "abc"});
  return {store, runs, session, start, tick: (ms = 10) => { now += ms; }};
}

test("a run starts running without a thread, and binding gives it one only once", () => {
  const {runs, start} = setup();
  const run = start();
  assert.deepEqual([run.kind, run.status, run.threadId, run.focus, run.providerId, run.model, run.createdAt, run.finishedAt],
    ["review", "running", null, "security", "claude-code", "sonnet", 1_000, null]);
  assert.equal(runs.baseline(run.id), "abc");
  assert.equal(runs.bind(run.id, "thr_run"), true);
  assert.equal(runs.bind(run.id, "thr_other"), false);
  assert.equal(runs.run(run.id)!.threadId, "thr_run");
  assert.deepEqual(runs.ofThread("thr_run").map(item => item.id), [run.id]);
});

test("binding moves the sends recorded for the run before it had a thread", () => {
  const {store, runs, session, start} = setup();
  const run = start("fix");
  const thread = store.createThread({sessionId: session.id, filePath: "a.ts", side: "new", startLine: 1, endLine: 1, severity: null, anchorContent: "x", body: "Fix"});
  store.recordSend(session.id, pendingRunThread(run.id), [thread.id], "");
  runs.bind(run.id, "thr_fix");
  assert.equal(store.thread(thread.id)!.delivery?.threadId, "thr_fix");
  assert.deepEqual(store.threadsSentTo("thr_fix").map(item => item.id), [thread.id]);
});

test("finishing keeps the summary and changed files, restarting runs it again, closing ends it for good", () => {
  const {runs, start, tick} = setup();
  const run = start();
  tick(50);
  runs.finish(run.id, "done", "Two comments.", ["a.ts"]);
  assert.deepEqual(runs.run(run.id), {...run, status: "done", summary: "Two comments.", changedFiles: ["a.ts"], finishedAt: 1_050});
  runs.restart(run.id);
  assert.deepEqual([runs.run(run.id)!.status, runs.run(run.id)!.finishedAt], ["running", null]);
  runs.close(run.id);
  runs.restart(run.id);
  runs.finish(run.id, "failed", "late", null);
  assert.deepEqual([runs.run(run.id)!.status, runs.run(run.id)!.summary], ["closed", "Two comments."]);
});

test("a view's reviewer is its latest open review run with a thread", () => {
  const {runs, session, start, tick} = setup();
  const first = start();
  runs.bind(first.id, "thr_1");
  tick();
  const summary = start("summary");
  runs.bind(summary.id, "thr_2");
  tick();
  const unbound = start();
  assert.equal(runs.reviewer(session.id)!.id, first.id);
  runs.bind(unbound.id, "thr_3");
  assert.equal(runs.reviewer(session.id)!.id, unbound.id);
  runs.close(unbound.id);
  runs.close(first.id);
  assert.equal(runs.reviewer(session.id), null);
  assert.deepEqual(runs.open(session.id).map(item => item.kind), ["summary"]);
});

test("a thread whose runs are all closed is a closed run thread; the reviewed thread is not", () => {
  const {runs, start} = setup();
  const run = start();
  runs.bind(run.id, "thr_run");
  assert.equal(runs.isClosedRunThread("thr_run"), false);
  runs.close(run.id);
  assert.equal(runs.isClosedRunThread("thr_run"), true);
  assert.equal(runs.isClosedRunThread("thr_parent"), false);
  assert.deepEqual(runs.ofThread("thr_run"), []);
});

test("a run that could not start is stored failed with the reason", () => {
  const {runs, session} = setup();
  const run = runs.create({sessionId: session.id, kind: "explain", focus: "a.ts:3", providerId: "codex", model: null, parentThreadId: null, baseline: null,
    failed: "The provider is not signed in."});
  assert.deepEqual([run.status, run.summary, run.finishedAt], ["failed", "The provider is not signed in.", 1_000]);
});

test("a review run's thread sees and answers every thread of its session; a closed run loses every right", () => {
  const {store, runs, session, start} = setup();
  const other = store.session("copy_1", "staged");
  const mine = store.createThread({sessionId: session.id, filePath: "a.ts", side: null, startLine: 0, endLine: 0, severity: null, anchorContent: null, body: "@reviewer why?"});
  const elsewhere = store.createThread({sessionId: other.id, filePath: "b.ts", side: null, startLine: 0, endLine: 0, severity: null, anchorContent: null, body: "Hm"});
  const run = start();
  runs.bind(run.id, "thr_run");
  assert.deepEqual(store.agentThreads("thr_run").map(row => row.id), [mine.id]);
  const answer = (threadId: string) => store.answerAsAgent({threadId, callerThreadId: "thr_run", ackBefore: null, authorName: "Codex", body: "Because.", status: null});
  assert.equal(answer(elsewhere.id), null);
  assert.notEqual(answer(mine.id), null);
  // A send to the run's thread counts too, until the run is closed.
  store.recordSend(other.id, "thr_run", [elsewhere.id], "");
  assert.deepEqual(store.agentThreads("thr_run").map(row => row.id), [mine.id, elsewhere.id]);
  runs.close(run.id);
  assert.deepEqual(store.agentThreads("thr_run"), []);
  assert.equal(answer(mine.id), null);
  assert.equal(answer(elsewhere.id), null);
});

test("a fix run answers only the threads sent to it", () => {
  const {store, runs, session, start} = setup();
  const sent = store.createThread({sessionId: session.id, filePath: "a.ts", side: null, startLine: 0, endLine: 0, severity: null, anchorContent: null, body: "Fix"});
  store.createThread({sessionId: session.id, filePath: "b.ts", side: null, startLine: 0, endLine: 0, severity: null, anchorContent: null, body: "Not this"});
  const run = start("fix");
  store.recordSend(session.id, pendingRunThread(run.id), [sent.id], "");
  runs.bind(run.id, "thr_fix");
  assert.deepEqual(store.agentThreads("thr_fix").map(row => row.id), [sent.id]);
});
