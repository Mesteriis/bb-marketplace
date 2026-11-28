import assert from "node:assert/strict";
import { test } from "node:test";
import { accountCheck } from "../src/adapters/bb/connection.ts";

const github = {kind: "github" as const, id: "a", label: "Me", origin: "https://github.com", organization: "", username: "me"};
const gitlab = {kind: "gitlab" as const, id: "b", label: "Office", origin: "https://gitlab.example.net", organization: "", username: "me"};
const gitea = {kind: "gitea" as const, id: "c", label: "Home", origin: "https://git.example.org", organization: "", username: "me"};

test("a GitHub check reads the login, the repositories and the token's scopes and end from the headers; the token is in no answer", async () => {
  const send: typeof fetch = async input => String(input).endsWith("/user")
    ? Response.json({login: "me"}, {headers: {"x-oauth-scopes": "repo, read:org", "github-authentication-token-expiration": "2026-12-01 10:00:00 +0100"}})
    : Response.json([{id: 1, name: "api", full_name: "me/api", clone_url: "https://github.com/me/api.git"}]);
  const found = await accountCheck(github, "fixture-secret", send, () => "2026-11-28T12:00:00.000Z");
  assert.deepEqual(found, {ok: true, login: "me", repositories: 1, more: false, scopes: ["repo", "read:org"], expiresAt: "2026-12-01T09:00:00.000Z",
    version: null, checkedAt: "2026-11-28T12:00:00.000Z"});
  assert.equal(JSON.stringify(found).includes("fixture-secret"), false);
  // A fine-grained token lists no scopes: nothing is said of them.
  const fine: typeof fetch = async input => String(input).endsWith("/user") ? Response.json({login: "me"}) : Response.json([]);
  const plain = await accountCheck(github, "fixture-secret", fine, () => "2026-11-28T12:00:00.000Z");
  assert.ok(plain.ok);
  if (plain.ok) assert.deepEqual([plain.scopes, plain.expiresAt, plain.repositories], [null, null, 0]);
});

test("GitLab says the token's scopes and end, Gitea its version; what they do not answer stays unknown", async () => {
  const asked: string[] = [];
  const lab: typeof fetch = async input => {
    const url = String(input); asked.push(new URL(url).pathname);
    return url.endsWith("/user") ? Response.json({username: "me"}) : url.endsWith("/personal_access_tokens/self")
      ? Response.json({scopes: ["read_api"], expires_at: "2026-12-01"}) : Response.json([]);
  };
  const found = await accountCheck(gitlab, "fixture-secret", lab, () => "2026-11-28T12:00:00.000Z");
  assert.ok(found.ok);
  if (found.ok) assert.deepEqual([found.login, found.scopes, found.expiresAt], ["me", ["read_api"], "2026-12-01T00:00:00.000Z"]);
  assert.ok(asked.includes("/api/v4/personal_access_tokens/self"));
  const tea: typeof fetch = async input => {
    const url = String(input);
    return url.endsWith("/user") ? Response.json({login: "me"}) : url.endsWith("/version") ? Response.json({version: "1.25.1"}) : Response.json([]);
  };
  const home = await accountCheck(gitea, "fixture-secret", tea, () => "2026-11-28T12:00:00.000Z");
  assert.ok(home.ok);
  if (home.ok) assert.deepEqual([home.version, home.scopes], ["1.25.1", null]);
  const quiet: typeof fetch = async input => {
    const url = String(input);
    return url.endsWith("/user") ? Response.json({username: "me"}) : url.endsWith("/self") ? new Response("no", {status: 404}) : Response.json([]);
  };
  const unknown = await accountCheck(gitlab, "fixture-secret", quiet, () => "2026-11-28T12:00:00.000Z");
  assert.ok(unknown.ok);
  if (unknown.ok) assert.deepEqual([unknown.scopes, unknown.expiresAt], [null, null]);
});

test("a rejected token is a failed check with its code", async () => {
  const denied: typeof fetch = async () => new Response("no", {status: 401});
  const found = await accountCheck(github, "fixture-secret", denied, () => "2026-11-28T12:00:00.000Z");
  assert.deepEqual(found, {ok: false, code: "PROVIDER_DENIED"});
});
