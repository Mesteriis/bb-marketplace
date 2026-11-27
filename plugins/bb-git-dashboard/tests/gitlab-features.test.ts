import test from "node:test";
import assert from "node:assert/strict";
import { repositoryFeatures } from "../src/adapters/bb/repository-features.ts";
import { client } from "../src/adapters/bb/provider-http.ts";
import type { Account, Repo } from "../src/core/providers.ts";

const account: Account = {kind: "gitlab", id: "gl", label: "GL", origin: "https://gitlab.example.org", organization: "", username: "octo"};
const repo: Repo = {id: "42", accountId: "gl", project: "group/sub", name: "app", path: "group/sub/app", clone: "https://gitlab.example.org/group/sub/app.git", branch: "main", canPush: null};
const base = "/api/v4/projects/42";
function http(routes: Record<string, () => Response>) {
  const paths: string[] = [];
  const send = (async (target: string | URL) => {
    const url = new URL(String(target));
    paths.push(url.pathname + url.search);
    return routes[url.pathname]?.() ?? Response.json({message: "404 Not found"}, {status: 404});
  }) as typeof fetch;
  return {http: client(account, "fixture-token-value", send), paths};
}

test("GitLab issues are listed with their labels", async () => {
  const {http: h, paths} = http({[base + "/issues"]: () => Response.json([{iid: 3, title: "Broken build", state: "opened", labels: ["bug", "ci"],
    updated_at: "2026-11-27T10:00:00Z", web_url: "https://gitlab.example.org/group/sub/app/-/issues/3"}])});
  assert.deepEqual(await repositoryFeatures(account, repo, "issues", h), {notice: null, items: [{id: "3", name: "#3 Broken build", status: "open",
    detail: "bug, ci", updated: "2026-11-27T10:00:00Z", url: "https://gitlab.example.org/group/sub/app/-/issues/3"}]});
  assert.equal(paths[0], base + "/issues?state=all&per_page=30");
});

test("GitLab CI variables show their name and flags, never their value", async () => {
  const {http: h} = http({[base + "/variables"]: () => Response.json([
    {key: "DEPLOY_TOKEN", value: "fixture-secret-value", variable_type: "env_var", protected: true, masked: true, environment_scope: "*"},
    {key: "KUBECONFIG", value: "fixture-file-value", variable_type: "file", protected: false, masked: false, environment_scope: "production"},
  ])});
  const result = await repositoryFeatures(account, repo, "variables", h);
  assert.deepEqual(result, {notice: "Values are not shown.", items: [
    {id: "Variable:DEPLOY_TOKEN:*", name: "DEPLOY_TOKEN", status: "Variable", detail: "protected, masked", updated: null, url: null},
    {id: "File:KUBECONFIG:production", name: "KUBECONFIG", status: "File", detail: "environment production", updated: null, url: null},
  ]});
  assert.doesNotMatch(JSON.stringify(result), /fixture-(secret|file)-value/);
});

test("GitLab variables a developer cannot read are explained, not an error", async () => {
  const {http: h} = http({[base + "/variables"]: () => Response.json({message: "403 Forbidden"}, {status: 403})});
  assert.deepEqual(await repositoryFeatures(account, repo, "variables", h), {items: [], notice: "CI/CD variables need the Maintainer role in this project."});
});

test("the Actions section of a GitLab project lists its pipelines", async () => {
  const {http: h} = http({[base + "/pipelines"]: () => Response.json([{id: 501, iid: 12, status: "failed", ref: "main", name: null,
    updated_at: "2026-11-27T10:05:00Z", web_url: "https://gitlab.example.org/group/sub/app/-/pipelines/501"}])});
  assert.deepEqual((await repositoryFeatures(account, repo, "actions", h)).items, [{id: "501", name: "Pipeline #12", status: "failed", detail: "main",
    updated: "2026-11-27T10:05:00Z", url: "https://gitlab.example.org/group/sub/app/-/pipelines/501"}]);
});
