import assert from "node:assert/strict";
import { test } from "node:test";
import type { Preview, RemoteAction } from "../src/core/publication.ts";
import { prepareThroughAccount, type AccountSync } from "../src/ui/project/account-write.ts";

function stand(target: {accountId: string; repoId: string} | null) {
  const calls: string[] = [];
  const sync: AccountSync = {
    target: async () => { calls.push("target"); return target; },
    prepare: async (to, action) => { calls.push("prepare " + to.accountId + "/" + to.repoId + " " + action.kind); return {id: "pv_1"} as Preview; },
    publish: async id => { calls.push("publish " + id); throw new Error("not expected"); },
  };
  return {sync, calls};
}

test("a copy not linked to an account repository gets NO_ACCOUNT_LINK, and nothing is prepared or sent", async () => {
  for (const action of [{kind: "fetch", copyId: "c1"}, {kind: "push", copyId: "c1"}] as RemoteAction[]) {
    const {sync, calls} = stand(null);
    await assert.rejects(prepareThroughAccount(sync, action), /^Error: NO_ACCOUNT_LINK$/);
    assert.deepEqual(calls, ["target"]);
  }
});

test("a linked copy's write is prepared against its account repository, never published by preparing", async () => {
  const {sync, calls} = stand({accountId: "acc_1", repoId: "991"});
  const preview = await prepareThroughAccount(sync, {kind: "push", copyId: "c1"});
  assert.equal(preview.id, "pv_1");
  assert.deepEqual(calls, ["target", "prepare acc_1/991 push"]);
});
