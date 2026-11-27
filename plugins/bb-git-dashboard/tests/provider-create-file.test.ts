import test from "node:test";
import assert from "node:assert/strict";
import { provider } from "../src/adapters/bb/provider.ts";
import type { Account, Repo } from "../src/core/providers.ts";

type Call = {method: string; path: string; query: URLSearchParams; body: unknown};
function server(origin: string, routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    assert.equal(url.origin, origin);
    const call = {method: init?.method ?? "GET", path: decodeURIComponent(url.pathname), query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined};
    calls.push(call);
    const route = routes[call.method + " " + call.path];
    return route ? route(call) : Response.json({message: "not found"}, {status: 404});
  }) as typeof fetch;
  return {send, calls};
}
const base = "b".repeat(40);
const made = "c".repeat(40);
const change = {branch: "ci/node", base, baseBranch: "main", path: ".github/workflows/ci.yml", content: "name: CI\n", message: "Add CI"};
const b64 = Buffer.from("name: CI\n").toString("base64");
const repoOf = (accountId: string, path: string, id = "1", project = path.split("/")[0]): Repo =>
  ({id, accountId, project, name: path.split("/")[1], path, clone: "https://x.example/" + path + ".git", branch: "main", canPush: true});

test("GitHub: a branch ref at the base commit, then the file on it; the new commit is returned", async () => {
  const account: Account = {kind: "github", id: "gh", label: "GH", origin: "https://github.com", organization: "", username: "octo"};
  const {send, calls} = server("https://api.github.com", {
    "POST /repos/owner/app/git/refs": () => Response.json({ref: "refs/heads/ci/node"}, {status: 201}),
    "PUT /repos/owner/app/contents/.github/workflows/ci.yml": () => Response.json({commit: {sha: made}}, {status: 201}),
  });
  assert.equal(await provider(account, "t", send).createFile(repoOf("gh", "owner/app"), change), made);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["POST", "/repos/owner/app/git/refs", {ref: "refs/heads/ci/node", sha: base}],
    ["PUT", "/repos/owner/app/contents/.github/workflows/ci.yml", {message: "Add CI", content: b64, branch: "ci/node"}],
  ]);
});

test("Gitea: one call that creates the file in a new branch from the base branch", async () => {
  const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://gitea.example.org", organization: "", username: "octo"};
  const {send, calls} = server("https://gitea.example.org", {
    "POST /api/v1/repos/owner/app/contents/.gitea/workflows/ci.yml": () => Response.json({commit: {sha: made, parents: [{sha: base}]}}, {status: 201}),
  });
  assert.equal(await provider(account, "t", send).createFile(repoOf("gt", "owner/app"), {...change, path: ".gitea/workflows/ci.yml"}), made);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["POST", "/api/v1/repos/owner/app/contents/.gitea/workflows/ci.yml", {message: "Add CI", content: b64, branch: "main", new_branch: "ci/node"}],
  ]);
});

test("Gitea: a commit that does not start at the base is no outcome to trust", async () => {
  const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://gitea.example.org", organization: "", username: "octo"};
  const {send} = server("https://gitea.example.org", {
    "POST /api/v1/repos/owner/app/contents/ci.yml": () => Response.json({commit: {sha: made, parents: [{sha: "d".repeat(40)}]}}, {status: 201}),
  });
  await assert.rejects(provider(account, "t", send).createFile(repoOf("gt", "owner/app"), {...change, path: "ci.yml"}), {message: "STALE_HEAD"});
});

test("GitLab: one commit with a create action on a new branch started at the base commit", async () => {
  const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
  const {send, calls} = server("https://gitlab.example.org", {
    "POST /api/v4/projects/42/repository/commits": () => Response.json({id: made}, {status: 201}),
  });
  assert.equal(await provider(account, "t", send).createFile(repoOf("gl", "group/app", "42", "group"), {...change, path: ".gitlab-ci.yml"}), made);
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [["POST", "/api/v4/projects/42/repository/commits", {
    branch: "ci/node", start_sha: base, commit_message: "Add CI", actions: [{action: "create", file_path: ".gitlab-ci.yml", content: "name: CI\n"}],
  }]]);
});

test("Azure: one push whose ref update starts the new branch at the base commit", async () => {
  const account: Account = {kind: "azure", id: "az", label: "AZ", origin: "https://dev.azure.com", organization: "org", username: "octo"};
  const {send, calls} = server("https://dev.azure.com", {
    "POST /org/proj/_apis/git/repositories/r1/pushes": () => Response.json({commits: [{commitId: made}], refUpdates: [{newObjectId: made}]}, {status: 201}),
  });
  assert.equal(await provider(account, "t", send).createFile(repoOf("az", "proj/app", "r1", "proj"), {...change, path: "azure-pipelines.yml"}), made);
  assert.equal(calls[0].query.get("api-version"), "7.1");
  assert.deepEqual(calls[0].body, {
    refUpdates: [{name: "refs/heads/ci/node", oldObjectId: base}],
    commits: [{comment: "Add CI", changes: [{changeType: "add", item: {path: "/azure-pipelines.yml"}, newContent: {content: "name: CI\n", contentType: "rawtext"}}]}],
  });
});

test("a refused write is the forge's refusal, and a reply without a commit is an unknown outcome", async () => {
  const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
  const refused = server("https://gitlab.example.org", {"POST /api/v4/projects/42/repository/commits": () => Response.json({message: "A file with this name already exists"}, {status: 400})});
  await assert.rejects(provider(account, "t", refused.send).createFile(repoOf("gl", "group/app", "42"), change), {message: "PROVIDER_REJECTED"});
  const empty = server("https://gitlab.example.org", {"POST /api/v4/projects/42/repository/commits": () => Response.json({}, {status: 201})});
  await assert.rejects(provider(account, "t", empty.send).createFile(repoOf("gl", "group/app", "42"), change), {message: "OUTCOME_UNKNOWN"});
});
