import test from "node:test";
import assert from "node:assert/strict";
import { ciCli } from "../src/adapters/bb/ci-cli.ts";
import { gitDashboardCli } from "../src/adapters/bb/cli.ts";
import { reviewCommands } from "../src/adapters/bb/code-review-cli.ts";
import type { ReviewThread } from "../src/core/code-review/model.ts";

const thread = (status: ReviewThread["status"] = "open"): ReviewThread => ({id: "abcdef123456", sessionId: "s", filePath: "src/a.ts", side: "new",
  startLine: 3, endLine: 4, status, severity: "must-fix", anchorContent: "x\ny", createdAt: 1, updatedAt: 1,
  comments: [{id: "c", authorType: "user", authorName: "You", body: "Rename it.", createdAt: 1, editedAt: null}], delivery: null});

function setup() {
  const answers: {caller: string; prefix: string; action: string; text: string}[] = [];
  const ciCalls: string[] = [];
  const ci = ciCli({
    context: async () => ({copyId: "c1", permission: "read"}),
    service: {
      runs: async (_copyId, filter, page) => { ciCalls.push(filter + ":" + page); return {items: [], more: false, operations: {} as never, limitations: {}}; },
      run: async () => { throw new Error("NOT_FOUND"); }, workflows: async () => ({workflows: [], defaultBranch: "main"}),
      form: async () => ({dispatchable: false, inputs: []}), prepare: async () => ({id: "p", lines: []}), confirm: async () => ({}),
    },
    approve: async () => false,
  });
  const review = reviewCommands({
    sentTo: (_caller, all) => all ? [thread(), thread("resolved")] : [thread()],
    answer: async (caller, prefix, action, text) => {
      if (prefix === "0000") throw new Error("NOT_SENT_HERE");
      answers.push({caller, prefix, action, text});
      return thread(action === "reply" ? "open" : "resolved");
    },
  });
  return {cli: gitDashboardCli(ci, review), answers, ciCalls};
}

test("review reply, resolve and dismiss take words or base64, from the thread the comments went to", async () => {
  const {cli, answers} = setup();
  assert.equal((await cli.run(["review", "reply", "abcd", "It", "reads", "better."], {threadId: "thr_1"})).exitCode, 0);
  const text = "Fixed: `quotes` and\nnew lines.";
  const result = await cli.run(["review", "resolve", "abcdef", "--text-base64", Buffer.from(text + "\n").toString("base64")], {threadId: "thr_1"});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /^Resolved comment thread abcdef123456 \(src\/a\.ts:3-4 \(new side\)\)\./);
  assert.deepEqual(answers.map(row => [row.caller, row.prefix, row.action, row.text]), [["thr_1", "abcd", "reply", "It reads better."], ["thr_1", "abcdef", "resolve", text]]);
});

test("words and base64 together, bad base64, a missing thread and a refused id fail with their codes", async () => {
  const {cli, answers} = setup();
  const both = await cli.run(["review", "reply", "abcd", "x", "--text-base64", "eA=="], {threadId: "thr_1"});
  assert.equal(both.exitCode, 1);
  assert.match(both.stderr ?? "", /not both/);
  assert.match((await cli.run(["review", "reply", "abcd", "--text-base64", "!!"], {threadId: "thr_1"})).stderr ?? "", /not valid base64/);
  assert.match((await cli.run(["review", "dismiss", "abcd", "why"], {})).stderr ?? "", /inside the BB thread/);
  assert.match((await cli.run(["review", "reply", "0000", "x"], {threadId: "thr_1"})).stderr ?? "", /NOT_SENT_HERE/);
  assert.equal(answers.length, 0);
});

test("review list prints the open threads sent here with their code and comments, or all of them", async () => {
  const {cli} = setup();
  const open = await cli.run(["review", "list"], {threadId: "thr_1"});
  assert.equal(open.stdout, "abcdef123456  open · src/a.ts:3-4 (new side) · must-fix\n  Code:\n    | x\n    | y\n  User:\n    Rename it.\n");
  assert.equal(JSON.parse((await cli.run(["review", "list", "--all", "--json"], {threadId: "thr_1"})).stdout ?? "[]").length, 2);
});

test("ci commands keep their arguments through the declared parser", async () => {
  const {cli, ciCalls} = setup();
  assert.equal((await cli.run(["ci", "list", "--failed", "--page", "2"], {threadId: "thr_1"})).exitCode, 0);
  assert.deepEqual(ciCalls, ["failed:2"]);
  assert.equal((await cli.run(["ci", "list", "--failed", "--active"], {threadId: "thr_1"})).exitCode, 1);
  assert.equal((await cli.run(["ci", "cancel", "8"], {threadId: "thr_1"})).stderr, "ACCESS_DENIED");
  assert.equal((await cli.run(["--help"], {})).exitCode, 0);
});

test("review list --json drops whole threads to fit and still parses", async () => {
  const big = {...{id: "abcdef123456", sessionId: "s", filePath: "a.ts", side: "new" as const, startLine: 1, endLine: 1, status: "open" as const, severity: null,
    anchorContent: "y".repeat(300_000), createdAt: 1, updatedAt: 1, delivery: null, comments: []}};
  const cli = gitDashboardCli(ciCli({context: async () => ({copyId: "c", permission: "read"}), service: {} as never, approve: async () => false}),
    reviewCommands({sentTo: () => [big, {...big, id: "bcdef1234567"}], answer: async () => big}));
  const result = await cli.run(["review", "list", "--json"], {threadId: "thr_1"});
  assert.equal(JSON.parse(result.stdout ?? "").length, 1);
  assert.match(result.stderr ?? "", /1 thread\(s\) left out/);
});
