import test from "node:test";
import assert from "node:assert/strict";
import { accountFacts } from "../src/adapters/bb/github-facts.ts";
import type { Account } from "../src/core/providers.ts";

const account: Account = {kind: "github", id: "office", label: "office", origin: "https://github.com", organization: "", username: "work-login"};

test("organization logins come from /user/orgs across pages", async () => {
  const pages = [[{login: "work-org"}, {login: "Other"}], []];
  const seen: string[] = [];
  const facts = accountFacts(async () => ({account, token: "fixture-token-value"}), async target => {
    const url = new URL(String(target));
    seen.push(url.pathname + url.search);
    return Response.json(pages[Number(url.searchParams.get("page")) - 1] ?? []);
  });
  assert.deepEqual(await facts.orgs("office"), ["work-org", "Other"]);
  assert.equal(seen[0], "/user/orgs?per_page=100&page=1");
});

test("a repository is visible when the API returns it and invisible on 404", async () => {
  const facts = accountFacts(async () => ({account, token: "fixture-token-value"}), async target =>
    new URL(String(target)).pathname === "/repos/third/z"
      ? Response.json({id: 1, name: "z", full_name: "third/z", clone_url: "https://github.com/third/z.git"})
      : new Response("{}", {status: 404}));
  assert.equal(await facts.canSee("office", "third/z"), true);
  assert.equal(await facts.canSee("office", "third/hidden"), false);
});

test("an unavailable provider is an error, not invisibility", async () => {
  const facts = accountFacts(async () => ({account, token: "fixture-token-value"}), async () => new Response("{}", {status: 503}));
  await assert.rejects(facts.canSee("office", "third/z"), {message: "PROVIDER_UNAVAILABLE"});
});
