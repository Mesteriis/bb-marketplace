import test from "node:test";
import assert from "node:assert/strict";
import { provider } from "../src/adapters/bb/provider.ts";
import type { Account } from "../src/core/providers.ts";

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
const spec = {owner: null, name: "notes", description: "Notes \"app\"", visibility: "private" as const};

test("GitHub: a private repository of the user, or of an organization, without a first commit", async () => {
  const account: Account = {kind: "github", id: "gh", label: "GH", origin: "https://github.com", organization: "", username: "octo"};
  const made = {id: 77, name: "notes", full_name: "octo/notes", clone_url: "https://github.com/octo/notes.git", default_branch: "main", permissions: {push: true}};
  const {send, calls} = server("https://api.github.com", {
    "POST /user/repos": () => Response.json(made, {status: 201}),
    "POST /orgs/team/repos": () => Response.json({...made, full_name: "team/notes", clone_url: "https://github.com/team/notes.git"}, {status: 201}),
  });
  const api = provider(account, "fixture-token-value", send);
  assert.deepEqual(await api.createRepository(spec), {id: "77", accountId: "gh", project: "octo", name: "notes", path: "octo/notes",
    clone: "https://github.com/octo/notes.git", branch: "main", canPush: true});
  assert.equal((await api.createRepository({...spec, owner: "team", visibility: "public"})).path, "team/notes");
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["POST", "/user/repos", {name: "notes", description: "Notes \"app\"", private: true, auto_init: false}],
    ["POST", "/orgs/team/repos", {name: "notes", description: "Notes \"app\"", private: false, auto_init: false}],
  ]);
});

test("Gitea: the same shape under /api/v1, with main as the default branch", async () => {
  const account: Account = {kind: "gitea", id: "gt", label: "GT", origin: "https://gitea.example.org", organization: "", username: "octo"};
  const made = {id: 5, name: "notes", full_name: "octo/notes", clone_url: "https://gitea.example.org/octo/notes.git", default_branch: "main", permissions: {push: true}};
  const {send, calls} = server("https://gitea.example.org", {"POST /api/v1/user/repos": () => Response.json(made, {status: 201})});
  assert.equal((await provider(account, "fixture-token-value", send).createRepository(spec)).clone, "https://gitea.example.org/octo/notes.git");
  assert.deepEqual(calls[0]!.body, {name: "notes", description: "Notes \"app\"", private: true, auto_init: false, default_branch: "main"});
});

test("GitLab: a project in the user's namespace, or in a group found by its path, private unless asked otherwise", async () => {
  const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
  const project = (path: string) => ({id: 91, name: "notes", path_with_namespace: path, namespace: {full_path: path.split("/").slice(0, -1).join("/")},
    http_url_to_repo: "https://gitlab.example.org/" + path + ".git", default_branch: "main"});
  const {send, calls} = server("https://gitlab.example.org", {
    "GET /api/v4/namespaces/team/sub": () => Response.json({id: 12, full_path: "team/sub"}),
    "POST /api/v4/projects": call => Response.json(project((call.body as {namespace_id?: number}).namespace_id ? "team/sub/notes" : "octo/notes"), {status: 201}),
  });
  const api = provider(account, "fixture-token-value", send);
  assert.equal((await api.createRepository(spec)).path, "octo/notes");
  assert.equal((await api.createRepository({...spec, owner: "team/sub", visibility: "public"})).path, "team/sub/notes");
  assert.deepEqual(calls.filter(call => call.method === "POST").map(call => call.body), [
    {name: "notes", path: "notes", description: "Notes \"app\"", visibility: "private", initialize_with_readme: false, default_branch: "main"},
    {name: "notes", path: "notes", description: "Notes \"app\"", visibility: "public", initialize_with_readme: false, default_branch: "main", namespace_id: 12},
  ]);
});

test("Azure: a repository in the named project, whose visibility is the project's", async () => {
  const account: Account = {kind: "azure", id: "az", label: "AZ", origin: "https://dev.azure.com", organization: "org", username: "octo"};
  const {send, calls} = server("https://dev.azure.com", {
    "GET /org/_apis/projects/Tools": () => Response.json({id: "p-1", name: "Tools", visibility: "private"}),
    "GET /org/_apis/projects/Open": () => Response.json({id: "p-2", name: "Open", visibility: "public"}),
    "POST /org/Tools/_apis/git/repositories": () => Response.json({id: "r-9", name: "notes", project: {name: "Tools"},
      remoteUrl: "https://org@dev.azure.com/org/Tools/_git/notes"}, {status: 201}),
  });
  const api = provider(account, "fixture-token-value", send);
  assert.deepEqual(await api.createRepository({...spec, owner: "Tools"}), {id: "r-9", accountId: "az", project: "Tools", name: "notes", path: "Tools/notes",
    clone: "https://dev.azure.com/org/Tools/_git/notes", branch: null, canPush: null});
  assert.deepEqual(calls[1]!.body, {name: "notes", project: {id: "p-1"}});
  await assert.rejects(api.createRepository(spec), {message: "INVALID_INPUT"});
  // A repository takes its project's visibility: one that differs from the choice is refused before anything is made.
  assert.equal(await api.repositoryVisibility!("Open"), "public");
  await assert.rejects(api.createRepository({...spec, owner: "Open"}), (error: Error & {detail?: string}) => error.message === "VISIBILITY_MISMATCH" && /public/.test(error.detail ?? ""));
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});
