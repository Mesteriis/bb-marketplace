import assert from "node:assert/strict";
import { test } from "node:test";
import { accountHealth, remoteHosts } from "../src/core/connections/health.ts";

const now = Date.parse("2026-11-28T12:00:00Z");
const base = {ok: true as const, login: "me", repositories: 5, more: false, scopes: null, expiresAt: null, version: null, checkedAt: "2026-11-28T11:58:00Z"};

test("a check becomes one state: works, works with a limit, expires soon, another login, or failed", () => {
  assert.deepEqual(accountHealth({kind: "github", username: "me"}, base, now), {tone: "good", state: "ok"});
  assert.deepEqual(accountHealth({kind: "github", username: "ME"}, {...base, scopes: ["repo", "workflow"]}, now), {tone: "good", state: "ok"});
  // A classic GitHub token without workflow cannot write CI files; a GitLab token without api cannot use the API fully.
  assert.deepEqual(accountHealth({kind: "github", username: "me"}, {...base, scopes: ["repo"]}, now), {tone: "warn", state: "limited", missing: "workflow"});
  assert.deepEqual(accountHealth({kind: "gitlab", username: "me"}, {...base, scopes: ["read_api"]}, now), {tone: "warn", state: "limited", missing: "api"});
  assert.deepEqual(accountHealth({kind: "gitlab", username: "me"}, {...base, scopes: ["api"], expiresAt: "2026-12-01T00:00:00Z"}, now),
    {tone: "warn", state: "expiring", days: 3});
  assert.deepEqual(accountHealth({kind: "gitlab", username: "me"}, {...base, scopes: ["api"], expiresAt: "2026-12-20T00:00:00Z"}, now), {tone: "good", state: "ok"});
  assert.deepEqual(accountHealth({kind: "gitlab", username: "me"}, {...base, expiresAt: "2026-11-27T00:00:00Z"}, now), {tone: "bad", state: "expired"});
  assert.deepEqual(accountHealth({kind: "gitea", username: "me"}, {...base, login: "someone"}, now), {tone: "bad", state: "other-login", login: "someone"});
  assert.deepEqual(accountHealth({kind: "gitea", username: "me"}, {ok: false, code: "PROVIDER_DENIED"}, now), {tone: "bad", state: "failed", code: "PROVIDER_DENIED"});
});

test("remote hosts of the projects folder are counted and matched to the accounts of their server", () => {
  const accounts = [
    {id: "a", label: "me", kind: "github" as const, origin: "https://github.com"},
    {id: "b", label: "bot", kind: "github" as const, origin: "https://github.com"},
    {id: "c", label: "me", kind: "gitea" as const, origin: "https://git.example.org"},
  ];
  const keys = ["github.com/acme/web", "github.com/acme/api", "git.example.org/me/notes", "gitlab.example.net/office/app", "gitlab.example.net/office/admin",
    "github.com/me/home", null, "alias-host/acme/x"];
  assert.deepEqual(remoteHosts(keys, accounts), [
    {host: "github.com", repositories: 3, kind: "github", accounts: ["a", "b"]},
    {host: "gitlab.example.net", repositories: 2, kind: null, accounts: []},
    {host: "alias-host", repositories: 1, kind: null, accounts: []},
    {host: "git.example.org", repositories: 1, kind: "gitea", accounts: ["c"]},
  ]);
  assert.deepEqual(remoteHosts([], accounts), []);
});
