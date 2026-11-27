import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewDiff } from "../src/core/code-review/diff.ts";
import { codeReviewService } from "../src/adapters/bb/code-review-service.ts";
import { codeReviewRuns, type SpawnRequest } from "../src/adapters/bb/code-review-runs.ts";
import { RunStore } from "../src/adapters/bb/review-run-store.ts";
import { ReviewStore } from "../src/adapters/bb/review-store.ts";
import { failureFor, type Copy } from "../src/core/workspace.ts";
import { memoryDb } from "./review-db.ts";

const COPY: Copy = {id: "copy_1", hostId: "host_1", root: "/work/app", identity: "a".repeat(64), projectId: "proj_1"};
const PATCH = "@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n";

function setup(options: {copy?: Copy; spawnFails?: string; modes?: string[] | null} = {}) {
  let now = 1_000;
  const db = memoryDb();
  const store = new ReviewStore(db, () => now);
  const runs = new RunStore(db, () => now);
  const spawned: SpawnRequest[] = [];
  const sent: {threadId: string; text: string}[] = [];
  const archived: string[] = [];
  const gone = new Set<string>();
  const changes: string[] = [];
  const copy = options.copy ?? COPY;
  let uncommitted: ReviewDiff = {files: [{path: "a.ts", previousPath: null, changeKind: "modified", additions: 2, deletions: 1, binary: false,
    untracked: false, patch: PATCH, tooLarge: false}], truncated: false, baseSha: null, headSha: null};
  const turnStarts = new Map<string, number>();
  const metadata: Record<string, unknown> = {};
  const threadCopies: Record<string, string> = {thr_owner: "copy_1", thr_elsewhere: "copy_2"};
  const host = {diff: async () => ({value: uncommitted, target: {kind: "uncommitted" as const}}), read: async () => ({text: "", sha256: ""}),
    write: async () => ({sha256: ""})};
  const review = codeReviewService({store, copy: async () => copy, host,
    threads: {send: async () => {}, providerName: async () => "Codex", turnStart: async id => turnStarts.get(id) ?? null,
      copyOf: async id => threadCopies[id] ?? null},
    changed: id => changes.push(id)});
  let next = 0;
  const service = codeReviewRuns({
    store, runs, review, copy: async () => copy, diff: host.diff,
    settings: async () => ({aiProvider: "", aiModel: "", aiPermissionMode: "auto"}),
    bb: {
      thread: async id => ({environmentId: id === "thr_owner" ? "env_1" : null, originPluginId: id.startsWith("thr_run") ? "bb-git-dashboard" : "other"}),
      metadata: async () => metadata,
      spawn: async request => {
        if (options.spawnFails) throw new Error(options.spawnFails);
        spawned.push(request);
        const id = "thr_run" + ++next;
        threadCopies[id] = "copy_1";
        return id;
      },
      send: async (threadId, text) => { if (gone.has(threadId)) throw new Error("NOT_FOUND"); sent.push({threadId, text}); },
      archive: async id => { archived.push(id); },
      models: async () => ({models: [{id: "m1", model: "sonnet", isDefault: false, defaultReasoningEffort: "low"},
        {id: "m2", model: "opus", isDefault: true, defaultReasoningEffort: "high"}], error: null}),
      permissionModes: async () => options.modes === undefined ? null : options.modes,
      turnStart: async id => turnStarts.get(id) ?? null,
      providerName: async () => "Claude Code",
    },
    threadCopy: async id => threadCopies[id] ?? null,
    pluginId: "bb-git-dashboard", changed: id => changes.push(id), log: () => {},
  });
  const session = store.session("copy_1", "uncommitted");
  const comment = (body = "Why?") => store.createThread({sessionId: session.id, filePath: "a.ts", side: "new", startLine: 2, endLine: 2, severity: null,
    anchorContent: "TWO", body});
  const execution = {providerId: "codex", model: "gpt", reasoningLevel: "high" as const};
  return {store, runs, review, service, session, comment, spawned, sent, archived, gone, changes, turnStarts, execution, metadata,
    setUncommitted: (diff: ReviewDiff) => { uncommitted = diff; }, tick: (ms = 10) => { now += ms; }};
}

test("an AI review starts as a child of the reviewed thread, in its environment, bound to the thread BB made", async () => {
  const {service, session, spawned, runs, execution} = setup();
  const run = await service.startReview({sessionId: session.id, threadId: "thr_owner", focuses: ["security", "tests"], instructions: "", execution});
  assert.deepEqual([run.kind, run.status, run.threadId, run.focus, run.providerId, run.model], ["review", "running", "thr_run1", "security, tests", "codex", "gpt"]);
  assert.deepEqual(spawned[0].place, {environmentId: "env_1", projectId: "proj_1", parentThreadId: "thr_owner"});
  assert.deepEqual([spawned[0].title, spawned[0].permissionMode, spawned[0].providerReasoning, spawned[0].runId], ["Review: security, tests", "auto", false, run.id]);
  assert.match(spawned[0].prompt, /security, tests/);
  assert.match(runs.baseline(run.id)!, /"a\.ts":"[0-9a-f]{16}"/);
  assert.equal(service.hasChildren("thr_owner"), true);
});

test("from the copy's own Review section a run starts on the copy's path in its project, in full mode where auto is missing", async () => {
  const {service, session, spawned, execution} = setup({modes: ["accept-edits", "full"]});
  await service.startSummary({sessionId: session.id, threadId: null, execution});
  assert.deepEqual(spawned[0].place, {hostId: "host_1", projectId: "proj_1", path: "/work/app"});
  assert.deepEqual([spawned[0].title, spawned[0].permissionMode], ["Summary of the changes", "full"]);
});

test("a thread on another copy does not become the parent, and a copy without a project has nowhere to run", async () => {
  const {service, session, spawned, execution} = setup();
  await service.startSummary({sessionId: session.id, threadId: "thr_elsewhere", execution});
  assert.equal("path" in spawned[0].place, true);
  const lonely = setup({copy: {...COPY, projectId: undefined}});
  await assert.rejects(lonely.service.startSummary({sessionId: lonely.session.id, threadId: null, execution}), /RUN_PLACE_REQUIRED/);
  assert.deepEqual(lonely.runs.open(lonely.session.id), []);
});

test("a start BB refuses leaves a failed run that says why, with its sends taken back", async () => {
  const {service, session, comment, store, execution} = setup({spawnFails: "PROVIDER_UNAVAILABLE"});
  const made = comment();
  const {run} = await service.fixInNewThread({sessionId: session.id, threadId: "thr_owner", threadIds: [made.id], note: "", execution});
  assert.deepEqual([run.status, run.summary], ["failed", "Could not start the thread: PROVIDER_UNAVAILABLE"]);
  assert.equal(store.thread(made.id)!.delivery, null);
});

test("a fix run gets the chosen open threads and answers them like any thread they were sent to", async () => {
  const {service, session, comment, store, review, spawned, execution} = setup();
  const chosen = comment("Rename it");
  const closed = comment("Old");
  store.setStatus(closed.id, "resolved");
  const {run, count} = await service.fixInNewThread({sessionId: session.id, threadId: "thr_owner", threadIds: [chosen.id, closed.id], note: "Keep it short", execution});
  assert.deepEqual([count, run.kind, spawned[0].title], [1, "fix", "Review fixes: 1 comment"]);
  assert.match(spawned[0].prompt, /Rename it/);
  assert.equal(store.thread(chosen.id)!.delivery?.threadId, "thr_run1");
  const answered = await review.answer("thr_run1", chosen.id.slice(0, 6), "resolve", "Renamed.");
  assert.equal(answered.status, "resolved");
  await assert.rejects(service.addComment("thr_run1", {filePath: "a.ts", side: "new", startLine: 2, endLine: 2, severity: null, body: "x"}), /NOT_A_REVIEW_RUN/);
});

test("a review run comments on lines the diff shows, and a refusal names the lines that are", async () => {
  const {service, session, store, execution} = setup();
  await service.startReview({sessionId: session.id, threadId: "thr_owner", focuses: [], instructions: "", execution});
  const made = await service.addComment("thr_run1", {filePath: "a.ts", side: "new", startLine: 2, endLine: 3, severity: "nit", body: "Split this."});
  assert.deepEqual([made.anchorContent, made.severity, made.comments[0].authorType, made.comments[0].authorName], ["TWO\nthree", "nit", "agent", "Claude Code"]);
  const general = await service.addComment("thr_run1", {filePath: "__general__", side: "new", startLine: 4, endLine: 9, severity: null, body: "Looks fine."});
  assert.deepEqual([general.side, general.startLine, general.endLine], [null, 0, 0]);
  const refused = await service.addComment("thr_run1", {filePath: "a.ts", side: "new", startLine: 7, endLine: 7, severity: null, body: "x"}).catch(error => error);
  assert.deepEqual(failureFor(refused, "GIT_REJECTED").detail, "Lines 7-7 of a.ts are not all shown on the new side of the diff. Lines shown there: 1-3.");
  const missing = await service.addComment("thr_run1", {filePath: "b.ts", side: null, startLine: 0, endLine: 0, severity: null, body: "x"}).catch(error => error);
  assert.deepEqual([failureFor(missing, "GIT_REJECTED").code, failureFor(missing, "GIT_REJECTED").detail], ["FILE_NOT_IN_DIFF", "Files in the diff: a.ts."]);
  assert.equal(store.threads(session.id).length, 2);
});

test("a run's turn ending finishes it with the agent's last words and the files it changed", async () => {
  const {service, session, runs, setUncommitted, execution} = setup();
  const run = await service.startReview({sessionId: session.id, threadId: "thr_owner", focuses: [], instructions: "", execution});
  setUncommitted({files: [{path: "a.ts", previousPath: null, changeKind: "modified", additions: 2, deletions: 1, binary: false, untracked: false,
    patch: PATCH + "+four\n", tooLarge: false}], truncated: false, baseSha: null, headSha: null});
  await service.turnEnded("thr_run1", "Left 2 comments.", false);
  assert.deepEqual([runs.run(run.id)!.status, runs.run(run.id)!.summary, runs.run(run.id)!.changedFiles], ["done", "Left 2 comments.", ["a.ts"]]);
});

test("@reviewer starts a reviewer with the question, then asks the same reviewer next time", async () => {
  const {service, session, comment, spawned, sent, store, runs, turnStarts, tick} = setup();
  const first = comment("@reviewer is this safe?");
  const started = await service.askReviewer(first.id, "thr_owner");
  assert.deepEqual([started!.kind, started!.threadId, spawned[0].providerReasoning, spawned[0].title], ["review", "thr_run1", true, "Reviewer: a.ts:2 (new side)"]);
  assert.equal(store.thread(first.id)!.delivery?.threadId, "thr_run1");
  turnStarts.set("thr_run1", 2_000);
  tick(2_000);
  const second = comment("@agent and this?");
  const asked = await service.askReviewer(second.id, "thr_owner");
  assert.equal(asked!.id, started!.id);
  assert.deepEqual([spawned.length, sent.length, sent[0].threadId], [1, 1, "thr_run1"]);
  assert.equal(runs.run(started!.id)!.status, "running");
  assert.equal(store.thread(second.id)!.delivery?.state, "sent");
});

test("a question queued behind a turn the reviewer has not started is not sent again", async () => {
  const {service, comment, sent, turnStarts, tick} = setup();
  const asked = comment("@reviewer why?");
  await service.askReviewer(asked.id, "thr_owner");
  turnStarts.set("thr_run1", 500);
  tick();
  await service.askReviewer(asked.id, "thr_owner");
  assert.equal(sent.length, 0);
});

test("a reviewer whose thread is gone is closed, and a new one takes the question", async () => {
  const {service, comment, spawned, gone, runs, turnStarts, tick} = setup();
  const first = await service.askReviewer(comment("@reviewer a").id, "thr_owner");
  turnStarts.set("thr_run1", 1_000);
  tick();
  gone.add("thr_run1");
  const second = await service.askReviewer(comment("@reviewer b").id, "thr_owner");
  assert.equal(runs.run(first!.id)!.status, "closed");
  assert.deepEqual([second!.threadId, spawned.length], ["thr_run2", 2]);
});

test("closing a run archives its thread and takes its rights", async () => {
  const {service, session, comment, store, archived, execution} = setup();
  const run = await service.startReview({sessionId: session.id, threadId: "thr_owner", focuses: [], instructions: "", execution});
  const made = comment();
  assert.deepEqual(store.agentThreads("thr_run1").map(row => row.id), [made.id]);
  await service.close(run.id);
  assert.deepEqual(archived, ["thr_run1"]);
  assert.deepEqual(store.agentThreads("thr_run1"), []);
  assert.deepEqual(service.list(session.id), []);
  await assert.rejects(service.close("ffffffffffff"), /UNKNOWN_RUN/);
});

test("the picker starts on the provider's default model where the run would start", async () => {
  const {service} = setup();
  assert.deepEqual(await service.defaults("copy_1", "thr_owner"), {
    execution: {providerId: "claude-code", model: "opus", reasoningLevel: "high"}, message: null, permissionMode: "auto",
    place: {kind: "environment", environmentId: "env_1"}});
  assert.deepEqual((await service.defaults("copy_1", null)).place, {kind: "host", hostId: "host_1"});
});

test("a thread that calls in before BB answered its start is bound only when BB stamped it as this plugin's", async () => {
  const {service, runs, session, metadata} = setup();
  const run = runs.create({sessionId: session.id, kind: "review", focus: null, providerId: "codex", model: null, parentThreadId: null, baseline: null});
  metadata.makoshReviewRunId = run.id;
  await service.bindIfPending("thr_other");
  assert.equal(runs.run(run.id)!.threadId, null);
  await service.bindIfPending("thr_run9");
  assert.equal(runs.run(run.id)!.threadId, "thr_run9");
});

test("@reviewer answers at once why no reviewer can start, and starts one in the background otherwise", async () => {
  const lonely = setup({copy: {...COPY, projectId: undefined}});
  const asked = lonely.comment("@reviewer why?");
  assert.equal(await lonely.service.onUserComment(asked, "@reviewer why?", null), "RUN_PLACE_REQUIRED");
  assert.deepEqual(lonely.runs.open(lonely.session.id), []);
  const {service, comment, spawned} = setup();
  const plain = comment("no mention");
  assert.equal(await service.onUserComment(plain, "no mention", "thr_owner"), null);
  const mentioned = comment("@agent look");
  assert.equal(await service.onUserComment(mentioned, "@agent look", "thr_owner"), null);
  assert.equal(await until(() => spawned.length === 1), true);
});

async function until(condition: () => boolean) {
  for (let index = 0; index < 50 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 5));
  return condition();
}
