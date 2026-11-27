import test from "node:test";
import assert from "node:assert/strict";
import { forgeLinks, type LinkPorts } from "../src/core/forge/links.ts";
import type { Account } from "../src/core/providers.ts";
import type { Copy } from "../src/core/workspace.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/Users/owner/projects/Personal/sandbox", identity: "a".repeat(64)};
const accounts: Account[] = [
  {kind: "github", id: "personal", label: "personal", origin: "https://github.com", organization: "", username: "Mesteriis"},
  {kind: "github", id: "office", label: "office", origin: "https://github.com", organization: "", username: "second-account"},
];
const sandbox = "https://github.com/Mesteriis/makosh-git-sandbox.git";

function setup(origin: string, overrides: Partial<LinkPorts> = {}) {
  const calls = {probe: 0, lookup: [] as string[], orgs: 0};
  const links = new Map<string, {accountId: string; repoId: string}>();
  const cache = new Map<string, {kind: null | "github" | "gitlab" | "gitea" | "azure"; checkedAt: number}>();
  const ports: LinkPorts = {
    origin: async () => origin,
    sshHostname: async (_hostId, alias) => alias === "github-office" ? "github.com" : alias,
    probe: async () => { calls.probe++; return "gitea"; },
    cache: {get: async host => cache.get(host), set: async (host, value) => { cache.set(host, value); }},
    now: () => 1_000,
    accounts: async () => accounts,
    facts: {orgs: async () => { calls.orgs++; return []; }, canSee: async () => false},
    lookup: async (accountId, path) => { calls.lookup.push(accountId + ":" + path); return {target: {accountId, repoId: "7"}, clone: sandbox}; },
    links: {get: async item => links.get(item.id), set: async (item, target) => { links.set(item.id, target); }},
    ...overrides,
  };
  return {links: forgeLinks(ports), stored: links, calls};
}

test("a copy cloned through an SSH alias connects to the owner's account automatically", async () => {
  const {links, stored, calls} = setup("git@github-office:Mesteriis/makosh-git-sandbox.git");
  const status = await links.status(copy);
  assert.deepEqual({remote: status.remote, kind: status.detection?.kind, chosen: status.chosen, reason: status.reason, linked: status.linked},
    {remote: {host: "github.com", path: "Mesteriis/makosh-git-sandbox"}, kind: "github", chosen: "personal", reason: "owner",
      linked: {accountId: "personal", repoId: "7"}});
  assert.deepEqual(stored.get("c1"), {accountId: "personal", repoId: "7"});
  assert.deepEqual(calls.lookup, ["personal:Mesteriis/makosh-git-sandbox"]);
  assert.equal((await links.status(copy)).reason, "linked");
  assert.deepEqual(calls.lookup, ["personal:Mesteriis/makosh-git-sandbox"]);
});

test("a repeated status check reuses the cached forge", async () => {
  const {links, calls} = setup("git@git.acme.example:team/app.git");
  await links.status(copy);
  const again = await links.status(copy);
  assert.equal(calls.probe, 1);
  assert.equal(again.detection?.status, "cached");
});

test("an ambiguous copy waits for the user's choice and then connects", async () => {
  const {links, stored} = setup("https://github.com/third/z.git", {
    facts: {orgs: async () => [], canSee: async () => true},
    lookup: async (accountId, path) => ({target: {accountId, repoId: "9"}, clone: "https://github.com/" + path + ".git"}),
  });
  const status = await links.status(copy);
  assert.equal(status.reason, "ambiguous");
  assert.deepEqual(status.candidates.map(account => account.id), ["personal", "office"]);
  assert.equal(status.linked, null);
  assert.deepEqual(await links.connect(copy, "office"), {accountId: "office", repoId: "9"});
  assert.deepEqual(stored.get("c1"), {accountId: "office", repoId: "9"});
});

test("connecting with an account of another forge is refused", async () => {
  const {links} = setup("https://github.com/Mesteriis/makosh-git-sandbox.git", {
    accounts: async () => [...accounts, {kind: "gitea", id: "g", label: "g", origin: "https://git.acme.example", organization: "", username: "u"}],
  });
  await assert.rejects(links.connect(copy, "g"), {message: "ACCESS_DENIED"});
});

test("a provider repository that is not the copy's origin is not linked", async () => {
  const {links, stored} = setup("git@github.com:Mesteriis/makosh-git-sandbox.git", {
    lookup: async accountId => ({target: {accountId, repoId: "7"}, clone: "https://github.com/Mesteriis/other.git"}),
  });
  const status = await links.status(copy);
  assert.equal(status.linked, null);
  assert.equal(status.error, "REMOTE_MISMATCH");
  assert.equal(stored.size, 0);
});

test("SSH and HTTPS remotes of one repository match for provider features", async () => {
  const {links} = setup("git@github-office:Mesteriis/makosh-git-sandbox.git");
  assert.equal(await links.originMatches(copy, "https://github.com/mesteriis/makosh-git-sandbox.git"), true);
  assert.equal(await links.originMatches(copy, "https://github.com/Mesteriis/other.git"), false);
});

test("a copy without a usable origin reports no remote", async () => {
  const {links} = setup("/srv/git/local.git");
  const status = await links.status(copy);
  assert.equal(status.remote, null);
  assert.equal(status.reason, "none");
});
