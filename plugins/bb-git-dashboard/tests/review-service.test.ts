import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewService } from "../src/adapters/bb/review-service.ts";
import type { PrDetail } from "../src/core/pulls/detail.ts";
import type { Issues } from "../src/core/issues/model.ts";
import type { PullReview } from "../src/core/pulls/review-port.ts";
import type { Account } from "../src/core/providers.ts";

const account = (kind: Account["kind"]): Account => ({kind, id: "a", label: "A", origin: "https://github.com", organization: "", username: "me"});
function setup(kind: Account["kind"] = "github", extra: Partial<PrDetail> = {}, act?: PullReview["act"]) {
  let head = "a".repeat(40);
  const acts: string[] = [];
  const review: PullReview = {
    detail: async number => ({forge: kind, id: "PR", headSha: head, number, repo: "o/r", headRefName: "f", baseRefName: "main", title: "T", pendingReviewId: null, ...extra} as PrDetail),
    files: async () => [],
    act: act ?? (async (_number, action) => { acts.push(action.kind); return {outcome: "completed"}; }),
  };
  const issues: Issues = {detail: async () => { throw new Error("unused"); }, act: async action => { acts.push("issue:" + action.kind); return {number: 9}; }};
  let now = 0;
  const service = reviewService({credential: async id => { if (id !== "a") throw new Error("ACCOUNT_UNCONFIGURED"); return {account: account(kind), token: "t"}; },
    review: () => review, issues: () => issues, now: () => now});
  return {service, acts, move: () => { head = "b".repeat(40); }, later: (ms: number) => { now += ms; }};
}

test("a write happens once, after its preview, against the head it was read with", async () => {
  const {service, acts} = setup();
  const preview = await service.prepare("a", "o/r", 7, {kind: "comment", body: "Thanks"});
  assert.deepEqual(preview.lines, ["Comment on o/r #7", "Thanks"]);
  assert.deepEqual(acts, []);
  assert.deepEqual(await service.confirm(preview.id), {outcome: "completed"});
  await assert.rejects(service.confirm(preview.id), {message: "PREVIEW_EXPIRED"});
  assert.deepEqual(acts, ["comment"]);
});

test("a head that moved after the preview refuses the write; an old preview expires", async () => {
  const moved = setup();
  const preview = await moved.service.prepare("a", "o/r", 7, {kind: "merge", method: "merge"});
  moved.move();
  await assert.rejects(moved.service.confirm(preview.id), {message: "STALE_HEAD"});
  assert.deepEqual(moved.acts, []);
  const old = setup();
  const late = await old.service.prepare("a", "o/r", 7, {kind: "comment", body: "x"});
  old.later(5 * 60_000 + 1);
  await assert.rejects(old.service.confirm(late.id), {message: "PREVIEW_EXPIRED"});
});

test("what the forge cannot do is refused at the preview", async () => {
  await assert.rejects(setup("gitlab").service.prepare("a", "o/r", 7, {kind: "review", event: "REQUEST_CHANGES", body: "No", comments: []}), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(setup("gitlab").service.prepare("a", "o/r", 7, {kind: "merge", method: "rebase"}), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(setup("azure").service.prepare("a", "o/r", 7, {kind: "review", event: "APPROVE", body: "",
    comments: [{path: "a.ts", line: 1, side: "RIGHT", startLine: null, body: "x"}]}), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(setup("azure").service.issuePrepare("a", "o/r", {kind: "create", title: "T", body: ""}), {message: "PROVIDER_UNSUPPORTED"});
  await assert.rejects(setup().service.prepare("other", "o/r", 7, {kind: "comment", body: "x"}), {message: "ACCOUNT_UNCONFIGURED"});
});

test("issue writes are previewed and confirmed once", async () => {
  const {service, acts} = setup();
  const preview = await service.issuePrepare("a", "o/r", {kind: "create", title: "Crash", body: ""});
  assert.deepEqual(preview.lines, ["Open an issue in o/r: “Crash”"]);
  assert.deepEqual(await service.issueConfirm(preview.id), {number: 9});
  await assert.rejects(service.issueConfirm(preview.id), {message: "PREVIEW_EXPIRED"});
  assert.deepEqual(acts, ["issue:create"]);
});

test("the preview is checked against the head the page showed, not only the head read at preview", async () => {
  const {service, acts} = setup();
  await assert.rejects(service.prepare("a", "o/r", 7, {kind: "lineComment", path: "a.ts", line: 1, side: "RIGHT", startLine: null, body: "x"}, "c".repeat(40)),
    {message: "STALE_HEAD"});
  const preview = await service.prepare("a", "o/r", 7, {kind: "comment", body: "x"}, "a".repeat(40));
  await service.confirm(preview.id);
  assert.deepEqual(acts, ["comment"]);
});

test("pull request and issue previews cannot be confirmed through each other", async () => {
  const {service, acts} = setup();
  const issue = await service.issuePrepare("a", "o/r", {kind: "create", title: "T", body: ""});
  await assert.rejects(service.confirm(issue.id), {message: "PREVIEW_EXPIRED"});
  const pull = await service.prepare("a", "o/r", 7, {kind: "comment", body: "x"});
  await assert.rejects(service.issueConfirm(pull.id), {message: "PREVIEW_EXPIRED"});
  assert.deepEqual(acts, []);
});

test("a review the forge would refuse is refused at the preview", async () => {
  const {service} = setup();
  await assert.rejects(service.prepare("a", "o/r", 7, {kind: "review", event: "REQUEST_CHANGES", body: " ", comments: []}), {message: "INVALID_INPUT"});
  await assert.rejects(service.prepare("a", "o/r", 7, {kind: "review", event: "COMMENT", body: "", comments: []}), {message: "INVALID_INPUT"});
});

test("a pending GitHub review blocks a new review or line comment until it is finished on GitHub", async () => {
  const {service} = setup("github", {pendingReviewId: "PRR_1"});
  await assert.rejects(service.prepare("a", "o/r", 7, {kind: "lineComment", path: "a.ts", line: 1, side: "RIGHT", startLine: null, body: "x"}), {message: "PENDING_REVIEW"});
  await service.prepare("a", "o/r", 7, {kind: "comment", body: "x"});
});

test("a write that stops halfway says how far it got", async () => {
  const {service} = setup("gitlab", {}, async () => { throw Object.assign(new Error("OUTCOME_PARTIAL"), {done: 2, total: 3}); });
  const preview = await service.prepare("a", "o/r", 7, {kind: "review", event: "APPROVE", body: "", comments: []});
  await assert.rejects(service.confirm(preview.id), {message: "OUTCOME_PARTIAL"});
});
