import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codeReviewService } from "../src/adapters/bb/code-review-service.ts";
import { ReviewStore } from "../src/adapters/bb/review-store.ts";
import type { ReviewDiff } from "../src/core/code-review/diff.ts";
import type { TargetRequest } from "../src/core/code-review/model.ts";
import type { Target } from "../src/core/code-review/model.ts";
import type { Copy } from "../src/core/workspace.ts";
import { memoryDb } from "./review-db.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/w/app", identity: "a".repeat(64), projectId: "p1"};
const patch = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join("\n");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function setup(options: {threadCopy?: Record<string, string>; turnStart?: number | null; sendFails?: boolean; empty?: TargetRequest["kind"][]} = {}) {
  let now = 1_000;
  const store = new ReviewStore(memoryDb(), () => now);
  let file = "one\nTWO\nthree\n";
  const sent: {threadId: string; text: string}[] = [];
  const published: string[] = [];
  const diff: ReviewDiff = {files: [{path: "a.ts", previousPath: null, changeKind: "modified", additions: 1, deletions: 1, binary: false, untracked: false, patch, tooLarge: false}],
    truncated: false, baseSha: null, headSha: null};
  const service = codeReviewService({
    store, copy: async id => id === "c1" ? copy : undefined,
    host: {
      diff: async (_copy, request) => ({value: options.empty?.includes(request.kind) ? {...diff, files: []} : diff, target: (request.kind === "branch" && !request.base ? {kind: "branch", base: "main"} : request) as Target}),
      read: async () => ({text: file, sha256: sha(file)}),
      write: async (_copy, _path, expected, text) => { if (expected !== sha(file)) throw new Error("CHANGED"); file = text; return {sha256: sha(text)}; },
    },
    threads: {
      send: async (threadId, text) => { if (options.sendFails) throw new Error("THREAD_UNAVAILABLE"); sent.push({threadId, text}); },
      providerName: async () => "Claude Code",
      turnStart: async () => options.turnStart === undefined ? null : options.turnStart,
      copyOf: async threadId => (options.threadCopy ?? {thr_work: "c1"})[threadId] ?? null,
    },
    changed: copyId => published.push(copyId),
  });
  return {service, store, sent, published, file: () => file, setFile: (text: string) => { file = text; }, tick: (ms = 10) => { now += ms; }};
}

test("a view reads the diff, makes its session and places each thread against the current lines", async () => {
  const {service} = setup();
  const first = await service.view("c1", {kind: "uncommitted"}, false);
  const thread = await service.createThread(first.sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: "must-fix", body: "Why upper case?"});
  assert.equal(thread.anchorContent, "TWO");
  const again = await service.view("c1", {kind: "uncommitted"}, false);
  assert.equal(again.sessionId, first.sessionId);
  assert.deepEqual(again.placements[thread.id], {state: "anchored", startLine: 2, endLine: 2});
  const branch = await service.view("c1", {kind: "branch"}, false);
  assert.deepEqual(branch.target, {kind: "branch", base: "main"});
  assert.notEqual(branch.sessionId, first.sessionId);
});

test("a comment on lines the diff does not show is refused; whole-file and whole-diff ones are not", async () => {
  const {service} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  await assert.rejects(service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 40, endLine: 40, anchorContent: null, severity: null, body: "?"}), {message: "LINE_NOT_IN_DIFF"});
  await assert.rejects(service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "  "}), {message: "INVALID_INPUT"});
  assert.equal((await service.createThread(sessionId, {filePath: "a.ts", side: null, startLine: 0, endLine: 0, anchorContent: null, severity: null, body: "File?"})).anchorContent, null);
  assert.equal((await service.createThread(sessionId, {filePath: "__general__", side: null, startLine: 0, endLine: 0, anchorContent: null, severity: "question", body: "Overall?"})).filePath, "__general__");
});

test("sending puts the open threads in the copy's thread as one prompt and marks them sent", async () => {
  const {service, sent} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: "nit", body: "Rename."});
  const result = await service.send(sessionId, "thr_work", [one.id], "Please be quick.");
  assert.equal(result.count, 1);
  assert.match(sent[0].text, /^# Address review comments/);
  assert.match(sent[0].text, new RegExp("### Thread `" + one.id + "` — a\\.ts:2 \\(new side\\) · nit"));
  assert.match(sent[0].text, /## Review summary\n\nPlease be quick\./);
  assert.match(sent[0].text, /bb git-dashboard review reply <thread-id> --text-base64-stdin/);
  assert.equal(service.threads(sessionId)[0].delivery?.state, "sent");
});

test("a send goes only to a thread working on this copy, and a failed one leaves nothing marked", async () => {
  const {service} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "?"});
  await assert.rejects(service.send(sessionId, "thr_elsewhere", [one.id], ""), {message: "WRONG_WORKSPACE"});
  const failing = setup({sendFails: true});
  const view = await failing.service.view("c1", {kind: "uncommitted"}, false);
  const two = await failing.service.createThread(view.sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "?"});
  await assert.rejects(failing.service.send(view.sessionId, "thr_work", [two.id], ""), {message: "THREAD_UNAVAILABLE"});
  assert.equal(failing.service.threads(view.sessionId)[0].delivery, null);
});

test("the agent answers by id prefix, only on threads sent to it, and resolve and dismiss close them", async () => {
  const {service, tick} = setup({turnStart: 5_000});
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "?"});
  await assert.rejects(service.answer("thr_work", one.id.slice(0, 5), "reply", "Hi"), {message: "NOT_SENT_HERE"});
  await service.send(sessionId, "thr_work", [one.id], "");
  tick();
  await assert.rejects(service.answer("thr_other", one.id, "reply", "Hi"), {message: "NOT_SENT_HERE"});
  await assert.rejects(service.answer("thr_work", "zz", "reply", "Hi"), {message: "INVALID_ID"});
  const replied = await service.answer("thr_work", one.id.slice(0, 6), "reply", "It reads better.");
  assert.deepEqual([replied.status, replied.delivery?.state, replied.comments.at(-1)?.authorName], ["open", "answered", "Claude Code"]);
  assert.deepEqual(service.sentTo("thr_work", false).map(thread => thread.id), [one.id]);
  assert.equal((await service.answer("thr_work", one.id, "resolve", "Fixed: lower case.")).status, "resolved");
  assert.deepEqual(service.sentTo("thr_work", false), []);
  assert.equal(service.sentTo("thr_work", true).length, 1);
});

test("a turn that ends without an answer marks the thread no reply, but not one sent after the turn began", async () => {
  const late = setup({turnStart: 500});
  const view = await late.service.view("c1", {kind: "uncommitted"}, false);
  const one = await late.service.createThread(view.sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "?"});
  await late.service.send(view.sessionId, "thr_work", [one.id], "");
  await late.service.turnEnded("thr_work");
  assert.equal(late.service.threads(view.sessionId)[0].delivery?.state, "sent");
  const ended = setup({turnStart: 5_000});
  const view2 = await ended.service.view("c1", {kind: "uncommitted"}, false);
  const two = await ended.service.createThread(view2.sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "?"});
  await ended.service.send(view2.sessionId, "thr_work", [two.id], "");
  await ended.service.turnEnded("thr_work");
  assert.equal(ended.service.threads(view2.sessionId)[0].delivery?.state, "no_reply");
  assert.deepEqual(ended.published.includes("c1"), true);
});

test("a suggestion is applied to the working file over the commented lines and resolves the thread", async () => {
  const {service, file} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: "suggestion",
    body: "Use lower case:\n```suggestion\ntwo\n```"});
  await service.applySuggestion(one.id, one.comments[0].id);
  assert.equal(file(), "one\ntwo\nthree\n");
  assert.equal(service.threads(sessionId)[0].status, "resolved");
  await assert.rejects(service.applySuggestion(one.id, one.comments[0].id), {message: "NOT_OPEN"});
});

test("a suggestion is not applied to a committed view or to removed lines", async () => {
  const {service} = setup();
  const {sessionId} = await service.view("c1", {kind: "commit", sha: "abcdef1"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "```suggestion\nx\n```"});
  await assert.rejects(service.applySuggestion(one.id, one.comments[0].id), {message: "NOT_WORKING_COPY"});
  const work = await service.view("c1", {kind: "uncommitted"}, false);
  const old = await service.createThread(work.sessionId, {filePath: "a.ts", side: "old", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null, body: "```suggestion\nx\n```"});
  await assert.rejects(service.applySuggestion(old.id, old.comments[0].id), {message: "NOT_WORKING_COPY"});
});

test("the anchor is the text the owner commented on, kept within its limit", async () => {
  const {service} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const made = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "what the owner saw", severity: null, body: "?"});
  assert.equal(made.anchorContent, "what the owner saw");
  await assert.rejects(service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "x".repeat(20_001), severity: null, body: "?"}),
    {message: "INVALID_INPUT"});
});

test("a suggestion follows its lines in the working file when they moved", async () => {
  const {service, file, setFile} = setup();
  const {sessionId} = await service.view("c1", {kind: "uncommitted"}, false);
  const one = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, anchorContent: "TWO", severity: null,
    body: "```suggestion\ntwo\n```"});
  setFile("zero\none\nTWO\nthree\n");
  await service.applySuggestion(one.id, one.comments[0].id);
  assert.equal(file(), "zero\none\ntwo\nthree\n");
  const gone = await service.createThread(sessionId, {filePath: "a.ts", side: "new", startLine: 3, endLine: 3, anchorContent: "nowhere", severity: null,
    body: "```suggestion\nx\n```"});
  await assert.rejects(service.applySuggestion(gone.id, gone.comments[0].id), {message: "CHANGED"});
});

test("a long commented range is cut in the message to the agent", async () => {
  const {sendPrompt} = await import("../src/core/code-review/prompt.ts");
  const long = "x".repeat(5000) + "\n```end";
  const text = sendPrompt({target: {kind: "uncommitted"}, note: "", threads: [{id: "abcdef123456", sessionId: "s", filePath: "a.ts", side: "new", startLine: 1, endLine: 2,
    status: "open", severity: null, anchorContent: long, createdAt: 1, updatedAt: 1, delivery: null,
    comments: [{id: "c", authorType: "user", authorName: "You", body: "Why?", createdAt: 1, editedAt: null}]}]});
  assert.match(text, /x{4000}\n… \(cut; read the file\)\n```\n/);
  assert.doesNotMatch(text, /```end/);
});

test("a first look at an empty uncommitted view shows the branch's commits instead, when there are any", async () => {
  const empty = setup({empty: ["uncommitted"]});
  assert.deepEqual((await empty.service.view("c1", {kind: "uncommitted"}, false, true)).target, {kind: "branch", base: "main"});
  assert.deepEqual((await empty.service.view("c1", {kind: "uncommitted"}, false)).target, {kind: "uncommitted"});
  const both = setup({empty: ["uncommitted", "branch"]});
  assert.deepEqual((await both.service.view("c1", {kind: "uncommitted"}, false, true)).target, {kind: "uncommitted"});
  const changed = setup();
  assert.deepEqual((await changed.service.view("c1", {kind: "uncommitted"}, false, true)).target, {kind: "uncommitted"});
});
