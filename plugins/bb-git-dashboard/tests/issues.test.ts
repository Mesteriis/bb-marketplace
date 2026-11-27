import assert from "node:assert/strict";
import { test } from "node:test";
import { giteaIssues } from "../src/adapters/bb/forges/issues/gitea.ts";
import { githubIssues } from "../src/adapters/bb/forges/issues/github.ts";
import { gitlabIssues } from "../src/adapters/bb/forges/issues/gitlab.ts";
import { describeIssueAction, issueAction } from "../src/core/issues/model.ts";
import type { Account } from "../src/core/providers.ts";

const token = "fixture-token-value";
type Call = {method: string; path: string; body: any};
function fake(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const call = {method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    return routes[call.method + " " + url.pathname]?.(call) ?? Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const created = "2026-11-27T00:00:00Z";

test("issue writes are validated and previewed", () => {
  assert.equal(issueAction.safeParse({kind: "create", title: " ", body: ""}).success, false);
  assert.deepEqual(describeIssueAction("o/r", {kind: "create", title: "Crash", body: "Steps"}), ["Open an issue in o/r: “Crash”", "Steps"]);
  assert.deepEqual(describeIssueAction("o/r", {kind: "state", number: 3, open: false}), ["Close o/r issue #3"]);
});

test("GitHub: an issue with its comments, and create, comment and close", async () => {
  const account: Account = {kind: "github", id: "gh", label: "GH", origin: "https://api.github.com", organization: "", username: "me"};
  const {send, calls} = fake({
    "GET /repos/o/r/issues/3": () => Response.json({number: 3, title: "Crash", body: "Steps", state: "open", user: {login: "sam"}, labels: [{name: "bug"}],
      html_url: "https://github.com/o/r/issues/3", created_at: created}),
    "GET /repos/o/r/issues/3/comments": () => Response.json([{user: {login: "ann"}, body: "Same here", created_at: created, html_url: "https://evil.example/x"}]),
    "POST /repos/o/r/issues": () => Response.json({number: 4}), "POST /repos/o/r/issues/3/comments": () => Response.json({id: 1}),
    "PATCH /repos/o/r/issues/3": () => Response.json({number: 3}),
  });
  const api = githubIssues(account, token, "o/r", send);
  assert.deepEqual(await api.detail(3), {number: 3, title: "Crash", body: "Steps", open: true, author: "sam", labels: ["bug"],
    url: "https://github.com/o/r/issues/3", createdAt: created, comments: [{author: "ann", body: "Same here", createdAt: created, url: ""}]});
  assert.deepEqual(await api.act({kind: "create", title: "New", body: "B"}), {number: 4});
  await api.act({kind: "comment", number: 3, body: "Hi"});
  await api.act({kind: "state", number: 3, open: false});
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => [call.method, call.path, call.body]), [
    ["POST", "/repos/o/r/issues", {title: "New", body: "B"}], ["POST", "/repos/o/r/issues/3/comments", {body: "Hi"}], ["PATCH", "/repos/o/r/issues/3", {state: "closed"}]]);
});

test("GitLab: notes without system ones, and create, comment and close by state event", async () => {
  const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "me"};
  const issue = "/api/v4/projects/group%2Fapp/issues";
  const {send, calls} = fake({
    ["GET " + issue + "/1"]: () => Response.json({iid: 1, title: "Crash", description: "Steps", state: "opened", author: {username: "sam"}, labels: ["bug"],
      web_url: "https://gitlab.example.org/group/app/-/issues/1", created_at: created}),
    ["GET " + issue + "/1/notes"]: () => Response.json([{body: "Same", author: {username: "ann"}, created_at: created, system: false},
      {body: "changed the description", author: {username: "sam"}, created_at: created, system: true}], {headers: {"x-next-page": ""}}),
    ["POST " + issue]: () => Response.json({iid: 2}), ["POST " + issue + "/1/notes"]: () => Response.json({id: 1}), ["PUT " + issue + "/1"]: () => Response.json({iid: 1}),
  });
  const api = gitlabIssues(account, token, "group/app", send);
  const detail = await api.detail(1);
  assert.deepEqual([detail.open, detail.comments.map(comment => comment.body)], [true, ["Same"]]);
  assert.deepEqual(await api.act({kind: "create", title: "New", body: "B"}), {number: 2});
  await api.act({kind: "comment", number: 1, body: "Hi"});
  await api.act({kind: "state", number: 1, open: false});
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => [call.method, call.path.replace(issue, "I"), call.body]), [
    ["POST", "I", {title: "New", description: "B"}], ["POST", "I/1/notes", {body: "Hi"}], ["PUT", "I/1", {state_event: "close"}]]);
});

test("Gitea: an issue and its comments, and create, comment and reopen", async () => {
  const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://git.example.org", organization: "", username: "me"};
  const repo = "/api/v1/repos/o/r/issues";
  const {send, calls} = fake({
    ["GET " + repo + "/5"]: () => Response.json({number: 5, title: "Crash", body: "", state: "closed", user: {login: "sam"}, labels: [{name: "bug"}],
      html_url: "https://git.example.org/o/r/issues/5", created_at: created}),
    ["GET " + repo + "/5/comments"]: () => Response.json([]), ["POST " + repo]: () => Response.json({number: 6}),
    ["POST " + repo + "/5/comments"]: () => Response.json({id: 1}), ["PATCH " + repo + "/5"]: () => Response.json({number: 5}),
  });
  const api = giteaIssues(account, token, "o/r", send);
  assert.equal((await api.detail(5)).open, false);
  assert.deepEqual(await api.act({kind: "create", title: "New", body: "B"}), {number: 6});
  await api.act({kind: "state", number: 5, open: true});
  assert.deepEqual(calls.filter(call => call.method !== "GET").map(call => [call.method, call.path.replace(repo, "I"), call.body]),
    [["POST", "I", {title: "New", body: "B"}], ["PATCH", "I/5", {state: "open"}]]);
});
