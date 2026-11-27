import test from "node:test";
import assert from "node:assert/strict";
import { provider } from "../src/adapters/bb/provider.ts";
import { checkConnection } from "../src/adapters/bb/connection.ts";
import type { Account, Repo } from "../src/core/providers.ts";

type Call = {method: string; path: string; query: URLSearchParams; auth: string | null; body: unknown};
function gitlab(routes: Record<string, (call: Call) => Response>, origin = "https://gitlab.example.org") {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    assert.equal(url.origin, origin);
    const call = {method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    const route = routes[call.method + " " + decodeURIComponent(url.pathname)];
    return route ? route(call) : Response.json({message: "404 Not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
const token = "fixture-token-value";
const project = {id: 42, name: "app", path_with_namespace: "group/sub/app", namespace: {full_path: "group/sub"},
  http_url_to_repo: "https://gitlab.example.org/group/sub/app.git", default_branch: "main"};
const repo: Repo = {id: "42", accountId: "gl", project: "group/sub", name: "app", path: "group/sub/app",
  clone: "https://gitlab.example.org/group/sub/app.git", branch: "main", canPush: null};
const mr = {iid: 7, title: "Add greeting", description: "Body", state: "opened", source_branch: "feature", target_branch: "main",
  sha: "a".repeat(40), diff_refs: {base_sha: "b".repeat(40)}, source_project_id: 42, target_project_id: 42, updated_at: "2026-11-27T10:00:00Z", merged_at: null};

test("member projects are listed with their nested group, a project is found by its full path", async () => {
  const {send, calls} = gitlab({
    "GET /api/v4/projects": () => Response.json([project], {headers: {"x-next-page": "2"}}),
    "GET /api/v4/projects/group/sub/app": () => Response.json(project),
  });
  const api = provider(account, token, send);
  const page = await api.repositories(1);
  assert.equal(calls[0].query.get("membership"), "true");
  assert.equal(calls[0].auth, "Bearer " + token);
  assert.deepEqual({item: page.items[0], more: page.more}, {item: repo, more: true});
  assert.deepEqual(await api.repository("group/sub/app"), repo);
  assert.match(calls[1].path, /\/projects\/group%2Fsub%2Fapp$/);
});

test("merge requests become pulls, with fork sources named by project id", async () => {
  const fork = {...mr, iid: 8, source_project_id: 99, state: "merged", merged_at: "2026-11-27T11:00:00Z"};
  const {send, calls} = gitlab({"GET /api/v4/projects/42/merge_requests": () => Response.json([mr, fork])});
  const {items} = await provider(account, token, send).pulls(repo, 1);
  assert.equal(calls[0].query.get("state"), "all");
  assert.deepEqual(items[0], {number: 7, title: "Add greeting", body: "Body", state: "open",
    head: {repo: "group/sub/app", branch: "feature", sha: "a".repeat(40)}, base: {repo: "group/sub/app", branch: "main", sha: "b".repeat(40)},
    updated: "2026-11-27T10:00:00Z", merged: false});
  assert.deepEqual([items[1].head.repo, items[1].state, items[1].merged], ["project 99", "merged", true]);
});

test("merge request details carry the diff, discussion and head pipeline", async () => {
  const {send} = gitlab({
    "GET /api/v4/projects/42/merge_requests/7": () => Response.json({...mr, head_pipeline: {id: 501, status: "failed"}}),
    "GET /api/v4/projects/42/merge_requests/7/diffs": () => Response.json([{old_path: "a.txt", new_path: "a.txt", diff: "@@ -1 +1 @@\n-1\n+2\n"}]),
    "GET /api/v4/projects/42/merge_requests/7/notes": () => Response.json([{system: false, author: {username: "ann"}, body: "Looks good"}, {system: true, author: {username: "bot"}, body: "added 1 commit"}]),
  });
  const details = await provider(account, token, send).details(repo, 7);
  assert.equal(details.diff, "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-1\n+2\n");
  assert.deepEqual(details.comments, [{author: "ann", body: "Looks good"}]);
  assert.deepEqual(details.checks, [{name: "Pipeline #501", state: "failed"}]);
  assert.deepEqual(details.issues, []);
});

test("writes go to the merge request endpoints with the expected head", async () => {
  const ok = () => Response.json({iid: 9, state: "merged"});
  const {send, calls} = gitlab({
    "GET /api/v4/projects/42/repository/branches/feature": () => Response.json({commit: {id: "a".repeat(40)}}),
    "GET /api/v4/projects/42/merge_requests/7": () => Response.json({...mr, reviewers: [{id: 3}]}),
    "GET /api/v4/users": () => Response.json([{id: 5, username: "rev"}]),
    "POST /api/v4/projects/42/merge_requests": ok, "POST /api/v4/projects/42/merge_requests/7/notes": ok,
    "PUT /api/v4/projects/42/merge_requests/7": ok, "PUT /api/v4/projects/42/merge_requests/7/merge": ok,
  });
  const api = provider(account, token, send);
  const sha = "a".repeat(40);
  assert.deepEqual(await api.mutate(repo, {kind: "create", head: "feature", base: "main", expected: sha, title: "T", body: "B"}), {number: 9, outcome: "completed"});
  await api.mutate(repo, {kind: "comment", number: 7, expected: sha, body: "hi"});
  await api.mutate(repo, {kind: "review", number: 7, expected: sha, reviewer: "rev"});
  await api.mutate(repo, {kind: "merge", number: 7, expected: sha});
  const writes = calls.filter(call => call.method !== "GET").map(call => [call.method, decodeURIComponent(call.path), call.body]);
  assert.deepEqual(writes, [
    ["POST", "/api/v4/projects/42/merge_requests", {source_branch: "feature", target_branch: "main", title: "T", description: "B"}],
    ["POST", "/api/v4/projects/42/merge_requests/7/notes", {body: "hi"}],
    ["PUT", "/api/v4/projects/42/merge_requests/7", {reviewer_ids: [3, 5]}],
    ["PUT", "/api/v4/projects/42/merge_requests/7/merge", {sha}],
  ]);
});

test("a stale head is refused before anything is written", async () => {
  const {send, calls} = gitlab({"GET /api/v4/projects/42/merge_requests/7": () => Response.json(mr)});
  await assert.rejects(provider(account, token, send).mutate(repo, {kind: "merge", number: 7, expected: "c".repeat(40)}), {message: "STALE_HEAD"});
  assert.equal(calls.filter(call => call.method !== "GET").length, 0);
});

test("a GitLab connection is checked through /user and lists member projects", async () => {
  const {send} = gitlab({"GET /api/v4/user": () => Response.json({username: "octo"}), "GET /api/v4/projects": () => Response.json([{...project, http_url_to_repo: "https://gitlab.com/group/sub/app.git"}])}, "https://gitlab.com");
  const checked = await checkConnection({kind: "gitlab", origin: "https://gitlab.com", organization: "", label: "GitLab", username: "", token}, "id", send);
  assert.deepEqual({username: checked.username, repositories: checked.repositories}, {username: "octo", repositories: ["group/sub/app"]});
});
