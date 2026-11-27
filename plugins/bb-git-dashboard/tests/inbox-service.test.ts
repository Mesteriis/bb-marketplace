import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxService, watchRound } from "../src/adapters/bb/inbox-service.ts";
import type { PullInbox } from "../src/core/pulls/inbox.ts";
import type { Pr } from "../src/core/pulls/model.ts";
import type { Watched } from "../src/core/pulls/watch.ts";
import type { Account } from "../src/core/providers.ts";

const account = (id: string, kind: Account["kind"] = "github"): Account => ({kind, id, label: id.toUpperCase(), origin: "https://github.com", organization: "", username: id});
const pr = (id: string): Pr => ({id, number: 1, title: "T", url: "https://github.com/o/r/pull/1", repo: "o/r", author: "a", baseRefName: "main", headRefName: "f",
  onDefaultBranch: true, stackedOn: null, isDraft: false, createdAt: "", updatedAt: "2026-11-27T00:00:00Z", mergedAt: null, closedAt: null,
  additions: null, deletions: null, ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: null, conflicts: false, blockers: [], myReview: null});

test("a tab gathers every account; a failing account reports its code and the others still show", async () => {
  const inboxes: Record<string, PullInbox> = {
    a: {list: async () => ({items: [pr("a1")], counts: {open: 1, review: 2}, notice: null}), watch: async () => null},
    b: {list: async () => { throw new Error("PROVIDER_DENIED"); }, watch: async () => null},
    c: {list: async () => ({items: [pr("c1")], counts: {open: 1}, notice: "note"}), watch: async () => null},
  };
  const accounts = [account("a"), account("b"), account("c", "gitlab")];
  const service = inboxService({accounts: async () => accounts,
    credential: async id => ({account: accounts.find(item => item.id === id)!, token: "t"}), inbox: found => inboxes[found.id]});
  const result = await service.list("open");
  assert.deepEqual(result.groups.map(group => [group.account.id, group.items.map(item => [item.id, item.accountId, item.forge]), group.error, group.notice]),
    [["a", [["a1", "a", "github"]], null, null], ["b", [], "PROVIDER_DENIED", null], ["c", [["c1", "c", "gitlab"]], null, "note"]]);
  // Account c answered without a review count, so the review total is unknown rather than 2.
  assert.deepEqual(result.counts, {open: 2});
});

const watched = (failing: string[]): Watched => ({id: "PR_1", repo: "o/r", number: 1, title: "T", url: "https://github.com/o/r/pull/1", failing, lastComment: null});
function store() {
  const data = new Map<string, unknown>();
  return {data, kv: {get: async <T>(key: string) => data.get(key) as T | undefined, set: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); }}};
}
const on = {ci: true, comments: true, ignore: ""};

test("a round alerts per account after its baseline, and a different viewer starts a new baseline", async () => {
  const {kv} = store();
  let viewer = "me", failing: string[] = [];
  const deps = {accounts: async () => [account("a")], credential: async (id: string) => ({account: account(id), token: "t"}), kv, now: () => "2026-11-27T10:00:00Z",
    inbox: (): PullInbox => ({list: async () => { throw new Error("unused"); }, watch: async () => ({viewer, prs: [watched(failing)]})})};
  assert.deepEqual(await watchRound(deps, on), []);
  failing = ["CI › unit"];
  assert.deepEqual((await watchRound(deps, on)).map(alert => [alert.accountId, alert.headline]), [["a", "CI failing · o/r#1"]]);
  assert.deepEqual(await watchRound(deps, on), []);
  viewer = "someone-else"; failing = ["CI › lint"];
  assert.deepEqual(await watchRound(deps, on), []);
});

test("one account failing does not stop the round; turning alerts off forgets the baselines", async () => {
  const {kv, data} = store();
  const deps = {accounts: async () => [account("a"), account("b")], credential: async (id: string) => ({account: account(id), token: "t"}), kv, now: () => "T",
    inbox: (found: Account): PullInbox => ({list: async () => ({items: [], counts: {}, notice: null}),
      watch: async () => { if (found.id === "a") throw new Error("PROVIDER_UNAVAILABLE"); return {viewer: "me", prs: []}; }})};
  await watchRound(deps, on);
  assert.deepEqual([...data.keys()], ["inbox-watch/b"]);
  await watchRound(deps, {ci: false, comments: false, ignore: ""});
  assert.deepEqual([...data.keys()], []);
});

test("a tab's total is shown only when every account that answered knows its count", async () => {
  const accounts = [account("a"), account("b", "gitea"), account("c")];
  const inboxes: Record<string, PullInbox> = {
    a: {list: async () => ({items: [], counts: {open: 1, merged: 0}, notice: null}), watch: async () => null},
    // Gitea has no count for merged pull requests.
    b: {list: async () => ({items: [pr("b1")], counts: {open: 2}, notice: null}), watch: async () => null},
    c: {list: async () => { throw new Error("PROVIDER_DENIED"); }, watch: async () => null},
  };
  const service = inboxService({accounts: async () => accounts, credential: async id => ({account: accounts.find(item => item.id === id)!, token: "t"}),
    inbox: found => inboxes[found.id]});
  assert.deepEqual((await service.list("open")).counts, {open: 3});
});

test("baselines of accounts that were removed are forgotten", async () => {
  const {kv, data} = store();
  data.set("inbox-watch/gone", {viewer: "me", state: {}});
  const deps = {accounts: async () => [account("b")], credential: async (id: string) => ({account: account(id), token: "t"}), kv, now: () => "T",
    keys: async () => [...data.keys()], inbox: (): PullInbox => ({list: async () => ({items: [], counts: {}, notice: null}), watch: async () => ({viewer: "me", prs: []})})};
  await watchRound(deps, on);
  assert.deepEqual([...data.keys()], ["inbox-watch/b"]);
});

test("each account's list says how many the forge counts; a history search reads the whole history where the forge can", async () => {
  const inboxes: Record<string, PullInbox> = {
    a: {list: async () => ({items: [pr("a1")], counts: {merged: 40}, notice: null}), watch: async () => null,
      history: async () => ({items: [pr("a1"), pr("a2")], total: 40})},
    c: {list: async () => ({items: [pr("c1")], counts: {}, notice: null}), watch: async () => null},
  };
  const accounts = [account("a"), account("c", "gitlab")];
  const service = inboxService({accounts: async () => accounts,
    credential: async id => ({account: accounts.find(item => item.id === id)!, token: "t"}), inbox: found => inboxes[found.id]});
  assert.deepEqual((await service.list("merged")).groups.map(group => [group.account.id, group.total]), [["a", 40], ["c", null]]);
  const history = await service.history("merged");
  assert.deepEqual(history.groups.map(group => [group.account.id, group.items.map(item => item.id), group.total]), [["a", ["a1", "a2"], 40], ["c", ["c1"], null]]);
});
