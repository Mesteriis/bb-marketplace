import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsHandlers, settingsRegistry } from "../src/adapters/bb/settings-rpc.ts";

const client = {experimental_caller: {kind: "client"}};

test("the plugin's settings section writes only the main settings, each through the module that owns it, for the app only", async () => {
  const written: [string, unknown][] = [];
  const registry = settingsRegistry();
  registry.add("catalog", ["projectsRoot"], async values => { written.push(["catalog", values]); });
  registry.add("interface", ["uiLanguage", "overviewView"], async values => { written.push(["interface", values]); });
  registry.add("inbox", ["inboxNotifyCi", "inboxNotifyComments"], async values => { written.push(["inbox", values]); });
  registry.add("review", ["aiPermissionMode"], async values => { written.push(["review", values]); });
  registry.add("templates", ["ciTemplatesFolder"], async values => { written.push(["templates", values]); });
  const {settingsSet} = settingsHandlers(registry);
  assert.equal((await settingsSet({uiLanguage: "ru"}, {experimental_caller: {kind: "agent"}})).ok, false);
  assert.deepEqual(written, []);
  assert.deepEqual(await settingsSet({uiLanguage: "ru", overviewView: "board", inboxNotifyCi: false}, client), {ok: true});
  assert.deepEqual(written, [["interface", {uiLanguage: "ru", overviewView: "board"}], ["inbox", {inboxNotifyCi: false}]]);
  written.length = 0;
  assert.deepEqual(await settingsSet({projectsRoot: "  /home/me/code  ", ciTemplatesFolder: "", aiPermissionMode: "accept-edits"}, client), {ok: true});
  assert.deepEqual(written, [["catalog", {projectsRoot: "/home/me/code"}], ["review", {aiPermissionMode: "accept-edits"}], ["templates", {ciTemplatesFolder: ""}]]);
  written.length = 0;
  // Anything else — a secret, the accounts, an unknown value or an empty projects folder — is refused whole.
  for (const bad of [{tokens: "{}"}, {accounts: "[]"}, {uiLanguage: "de"}, {projectsRoot: "   "}, {aiPermissionMode: "yolo"}, {inboxNotifyCi: "yes"}, {}]) {
    const answer = await settingsSet(bad as never, client);
    assert.equal(answer.ok ? "ok" : answer.code, "INVALID_INPUT", JSON.stringify(bad));
  }
  assert.deepEqual(written, []);
});
