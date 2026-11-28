import assert from "node:assert/strict";
import { test } from "node:test";
import { commitOfSummary, stageOfSummary } from "../src/core/panel/changes.ts";
import { foldMemory } from "../src/core/panel/folds.ts";
import { backFocus } from "../src/core/panel/target.ts";
import { pinPullTab, unpinTab, type PinPanel } from "../src/app/pin-tabs.ts";

const status = {root: "/w/app", branch: "feature", head: "a".repeat(40), snapshot: "snap-1", author: {name: "Dev", email: "dev@example.test"},
  files: [{path: "src/a.ts", index: "M", worktree: "."}, {path: "src/b.ts", index: ".", worktree: "M"}, {path: "notes.txt", index: "?", worktree: "?"}]};

test("Commit N in the summary commits what is staged against the status it was read with, and counts the staged files", () => {
  assert.deepEqual(commitOfSummary(status, "  Fix the panel  "), {staged: 1, action: {kind: "commit", expected: "snap-1", message: "  Fix the panel  "}});
  // Nothing staged, an empty message, no snapshot, no author or a conflict: no commit, the button stays off.
  assert.equal(commitOfSummary({...status, files: [{path: "src/b.ts", index: ".", worktree: "M"}]}, "Fix").action, null);
  assert.equal(commitOfSummary(status, "   ").action, null);
  assert.equal(commitOfSummary({...status, snapshot: undefined}, "Fix").action, null);
  assert.equal(commitOfSummary({...status, author: null}, "Fix").action, null);
  assert.equal(commitOfSummary({...status, files: [...status.files, {path: "both.ts", index: "A", worktree: "A"}]}, "Fix").action, null);
});

test("a file's box in the summary puts it in the index or takes it out", () => {
  assert.deepEqual(stageOfSummary({path: "src/a.ts", index: "M", worktree: "."}), {kind: "stage", path: "src/a.ts", staged: true});
  assert.deepEqual(stageOfSummary({path: "src/b.ts", index: ".", worktree: "M"}), {kind: "stage", path: "src/b.ts", staged: false});
  assert.deepEqual(stageOfSummary({path: "notes.txt", index: "?", worktree: "?"}), {kind: "stage", path: "notes.txt", staged: false});
});

test("a part folded or opened stays so for the next panel; History starts folded", () => {
  const memory = foldMemory(["history"]);
  assert.deepEqual([...memory.open()].sort(), ["changes", "ci", "pull", "review"]);
  const first = memory.toggle(memory.open(), "ci");
  assert.equal(first.has("ci"), false);
  const second = memory.toggle(first, "history");
  assert.equal(second.has("history"), true);
  // A new panel (another copy, a remount) opens as the last one was left.
  assert.deepEqual([...memory.open()].sort(), ["changes", "history", "pull", "review"]);
});

test("back from a part's screen returns the focus to that part's heading in the summary", () => {
  assert.equal(backFocus("changes"), "git-panel-changes");
  assert.equal(backFocus("ci"), "git-panel-ci");
  assert.equal(backFocus("review"), "git-panel-review");
  assert.equal(backFocus("history"), "git-panel-history");
  assert.equal(backFocus(null), null);
});

/** A stand-in for BB's panel controller: its open tabs, and what was asked of it. */
function fakePanel(tabs: {key: string; id: string; params: unknown}[], accepts = true) {
  const calls: string[] = [];
  const panel: PinPanel<{id: string}> = {
    getTabs: () => ({tabs: tabs.map(tab => ({key: tab.key, detail: {kind: "plugin", tab: {id: tab.id}, params: tab.params}}))}),
    selectTab: key => { calls.push("select " + key); return true; },
    closeTab: key => { calls.push("close " + key); return true; },
    openTab: options => { calls.push("open " + JSON.stringify(options.params)); return accepts; },
  };
  return {panel, calls};
}

test("Unpin closes the tab with these params and says false when it is no longer open", () => {
  const {panel, calls} = fakePanel([{key: "k1", id: "git-pinned", params: {copyId: "c1"}}, {key: "k2", id: "git-pinned", params: {copyId: "c2"}}]);
  assert.equal(unpinTab(panel, {id: "git-pinned"}, {copyId: "c2"}), true);
  assert.deepEqual(calls, ["close k2"]);
  assert.equal(unpinTab(panel, {id: "git-pinned"}, {copyId: "c3"}), false);
  assert.equal(unpinTab(panel, {id: "git-pinned-pr"}, {copyId: "c1"}), false);
  assert.deepEqual(calls, ["close k2"]);
});

test("pinning a pull request already pinned selects its tab — a pin of 0.14.6 by its repository id too", async () => {
  const tab = {id: "git-pinned-pr"};
  const never = async () => { throw new Error("not asked"); };
  const made = fakePanel([{key: "p1", id: "git-pinned-pr", params: {accountId: "acc_1", repo: "team/app", number: 7}}]);
  assert.equal(await pinPullTab(made.panel, tab, {accountId: "acc_1", repo: "Team/App", number: 7}, "app #7", never), "selected");
  assert.deepEqual(made.calls, ["select p1"]);

  const old = fakePanel([{key: "p2", id: "git-pinned-pr", params: {accountId: "acc_1", repoId: "991", number: 7}}]);
  const asked: string[] = [];
  assert.equal(await pinPullTab(old.panel, tab, {accountId: "acc_1", repo: "team/app", number: 7}, "app #7",
    async (accountId, repoId) => { asked.push(accountId + "/" + repoId); return "team/app"; }), "selected");
  assert.deepEqual(asked, ["acc_1/991"]);
  assert.deepEqual(old.calls, ["select p2"]);
});

test("another pull request opens a tab of its own, and a panel that declines it is an error", async () => {
  const tab = {id: "git-pinned-pr"};
  const other = fakePanel([{key: "p1", id: "git-pinned-pr", params: {accountId: "acc_1", repo: "team/app", number: 8}},
    {key: "p2", id: "git-pinned-pr", params: {accountId: "acc_1", repoId: "991", number: 7}}]);
  assert.equal(await pinPullTab(other.panel, tab, {accountId: "acc_1", repo: "team/app", number: 7}, "app #7", async () => "team/other"), "opened");
  assert.deepEqual(other.calls, ["open {\"accountId\":\"acc_1\",\"repo\":\"team/app\",\"number\":7}"]);
  const declining = fakePanel([], false);
  await assert.rejects(pinPullTab(declining.panel, tab, {accountId: "acc_1", repo: "team/app", number: 7}, "app #7", async () => null), /PANEL_DECLINED/);
});
