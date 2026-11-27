import test from "node:test";
import assert from "node:assert/strict";
import { explainPrompt, fixPrompt, gitCommandFor, REPORT_LINE, reviewPrompt, reviewerPrompt, summaryPrompt } from "../src/core/code-review/run-prompts.ts";
import type { ReviewThread } from "../src/core/code-review/model.ts";

const thread: ReviewThread = {id: "abcdef123456", sessionId: "s", filePath: "src/a.ts", side: "new", startLine: 3, endLine: 4, status: "open",
  severity: "question", anchorContent: "const a = `x`;\n``` ok", createdAt: 1, updatedAt: 1, delivery: null,
  comments: [{id: "c", authorType: "user", authorName: "You", body: "@reviewer why?", createdAt: 1, editedAt: null}]};

test("a review run gets the view, the focus, the owner's instructions, the git_review tools and the report line", () => {
  const text = reviewPrompt({target: {kind: "branch", base: "main"}, focus: "Security", instructions: "Look at the parser."});
  assert.match(text, /Diff under review: committed changes since main, in this workspace — read it with `git diff main\.\.\.HEAD`/);
  assert.match(text, /- Focus: Security/);
  assert.match(text, /## Instructions from the user\n\nLook at the parser\./);
  assert.match(text, /`git_review_comment`/);
  assert.match(text, /bb git-dashboard review/);
  assert.ok(text.includes(REPORT_LINE));
  assert.doesNotMatch(text, /diff_review|Diff Review/);
});

test("a range names the commits the tab compares", () => {
  assert.equal(gitCommandFor({kind: "range", from: "main", to: "feature", symmetric: true}, {baseSha: "a".repeat(7), headSha: "b".repeat(7)}),
    "`git diff aaaaaaa bbbbbbb` (the commits the tab compares for main...feature)");
});

test("code in a question to the reviewer and in an explanation is fenced past its own backticks", () => {
  const asked = reviewerPrompt({kind: "uncommitted"}, thread, false);
  assert.match(asked, /\n````\nconst a = `x`;\n``` ok\n````\n/);
  assert.match(asked, /Thread: `abcdef123456` — src\/a\.ts:3-4 \(new side\)/);
  const explained = explainPrompt({kind: "uncommitted"}, {filePath: "src/a.ts", side: "new", startLine: 3, endLine: 4, code: "```"});
  assert.match(explained, /# Explain lines 3-4 of `src\/a\.ts` \(the new side\)/);
  assert.match(explained, /\n````\n```\n````\n/);
});

test("a fix run and a summary carry their instructions and the report line", () => {
  const fix = fixPrompt({target: {kind: "uncommitted"}, threads: [thread], note: ""});
  assert.match(fix, /Make the fixes here; that thread is not asked to\./);
  assert.match(fix, /# Address review comments/);
  assert.ok(summaryPrompt({kind: "commit", sha: "abcdef1"}).includes("`git_review_general_comment`"));
});
