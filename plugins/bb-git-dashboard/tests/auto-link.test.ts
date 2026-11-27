import test from "node:test";
import assert from "node:assert/strict";
import { forgeLinks, type LinkPorts } from "../src/core/forge/links.ts";
import type { Account } from "../src/core/providers.ts";
import type { Copy } from "../src/core/workspace.ts";

const copy: Copy = {id: "c1", hostId: "mac", root: "/Users/owner/projects/Personal/sandbox", identity: "a".repeat(64)};
const accounts: Account[] = [
  {kind: "github", id: "personal", label: "personal", origin: "https://github.com", organization: "", username: "Octo-Owner"},
  {kind: "github", id: "office", label: "office", origin: "https://github.com", organization: "", username: "work-login"},
];
const sandbox = "https://github.com/Octo-Owner/sandbox-repo.git";

function setup(origin: string, overrides: Partial<LinkPorts> = {}) {
  const calls = {probe: 0, lookup: [] as string[], orgs: 0};
  const links = new Map<string, {accountId: string; repoId: string}>();
  const cache = new Map<string, {kind: null | "github" | "gitlab" | "gitea" | "azure"; checkedAt: number}>();
  const ports: LinkPorts = {
    origin: async () => origin,
    sshHostname: async (_hostId, alias) => alias === "github-work-alias" ? "github.com" : alias,
    probe: async () => { calls.probe++; return "gitea"; },
    cache: {get: async host => cache.get(host), set: async (host, value) => { cache.set(host, value); }},
    now: () => 1_000,
    accounts: async () => accounts,
    facts: {orgs: async () => { calls.orgs++; return []; }, canSee: async () => false},
    lookup: async (accountId, path) => { calls.lookup.push(accountId + ":" + path); return {target: {accountId, repoId: "7"}, clone: sandbox}; },
    links: {get: async item => links.get(item.id), set: async (item, target) => { links.set(item.id, target); }},
    ...overrides,
  };
  return {links: forgeLinks(ports), stored: links, calls, ports};
}
/** A new resolver over the same storage, as after a reload, with some ports replaced. */
function forgeLinksOver(state: ReturnType<typeof setup>, overrides: Partial<LinkPorts>) {
  return forgeLinks({...state.ports, ...overrides});
}

test("a copy cloned through an SSH alias connects to the owner's account automatically", async () => {
  const {links, stored, calls} = setup("git@github-work-alias:Octo-Owner/sandbox-repo.git");
  const status = await links.status(copy);
  assert.deepEqual({remote: status.remote, kind: status.detection?.kind, chosen: status.chosen, reason: status.reason, linked: status.linked},
    {remote: {host: "github.com", path: "Octo-Owner/sandbox-repo"}, kind: "github", chosen: "personal", reason: "owner",
      linked: {accountId: "personal", repoId: "7"}});
  assert.deepEqual(stored.get("c1"), {accountId: "personal", repoId: "7"});
  assert.deepEqual(calls.lookup, ["personal:Octo-Owner/sandbox-repo"]);
  assert.equal((await links.status(copy)).reason, "linked");
  assert.deepEqual(calls.lookup, ["personal:Octo-Owner/sandbox-repo"]);
});

test("a repeated status check reuses the cached forge", async () => {
  const {links, calls} = setup("git@git.example.org:team/app.git");
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
  const {links} = setup("https://github.com/Octo-Owner/sandbox-repo.git", {
    accounts: async () => [...accounts, {kind: "gitea", id: "g", label: "g", origin: "https://git.example.org", organization: "", username: "u"}],
  });
  await assert.rejects(links.connect(copy, "g"), {message: "ACCESS_DENIED"});
});

test("a provider repository that is not the copy's origin is not linked", async () => {
  const {links, stored} = setup("git@github.com:Octo-Owner/sandbox-repo.git", {
    lookup: async accountId => ({target: {accountId, repoId: "7"}, clone: "https://github.com/Octo-Owner/other.git"}),
  });
  const status = await links.status(copy);
  assert.equal(status.linked, null);
  assert.equal(status.error, "REMOTE_MISMATCH");
  assert.equal(stored.size, 0);
});

test("SSH and HTTPS remotes of one repository match for provider features", async () => {
  const {links} = setup("git@github-work-alias:Octo-Owner/sandbox-repo.git");
  assert.equal(await links.originMatches(copy, "https://github.com/octo-owner/sandbox-repo.git"), true);
  assert.equal(await links.originMatches(copy, "https://github.com/Octo-Owner/other.git"), false);
});

test("a copy without a usable origin reports no remote", async () => {
  const {links} = setup("/srv/git/local.git");
  const status = await links.status(copy);
  assert.equal(status.remote, null);
  assert.equal(status.reason, "none");
});

test("a server without an account that did not answer is not looked up", async () => {
  const {links, calls} = setup("git@gitlab.example.net:team/app.git", {probe: async () => "unreachable"});
  const status = await links.status(copy);
  assert.deepEqual({kind: status.detection?.kind, state: status.detection?.status, reason: status.reason, linked: status.linked},
    {kind: "gitlab", state: "unreachable", reason: "none", linked: null});
  assert.deepEqual(calls.lookup, []);
});

const azureCopy = (origin: string, extra: Partial<LinkPorts> = {}) => setup(origin, {
  accounts: async () => [{kind: "azure", id: "az-b", label: "B", origin: "https://dev.azure.com", organization: "orgB", username: "u"}],
  lookup: async (accountId, path) => ({target: {accountId, repoId: "r"}, clone: "https://dev.azure.com/orgB/" + path.replace("/", "/_git/")}),
  ...extra,
});

test("an Azure copy of one organization is never linked to another organization's repository", async () => {
  const {links, stored, calls} = azureCopy("git@ssh.dev.azure.com:v3/orgA/P/R");
  const status = await links.status(copy);
  assert.equal(status.linked, null);
  assert.equal(status.reason, "none");
  assert.deepEqual(calls.lookup, []);
  await assert.rejects(links.connect(copy, "az-b"), {message: "ACCESS_DENIED"});
  assert.equal(await links.originMatches(copy, "https://dev.azure.com/orgB/P/_git/R"), false);
  assert.equal(stored.size, 0);
});

test("an Azure copy links to the account of its own organization", async () => {
  const {links} = azureCopy("https://orgb.visualstudio.com/P/_git/R");
  assert.deepEqual((await links.status(copy)).linked, {accountId: "az-b", repoId: "r"});
});

test("a linked copy keeps its link when the host cannot be asked", async () => {
  const state = setup("git@github.com:Octo-Owner/sandbox-repo.git");
  await state.links.status(copy);
  const offline = forgeLinksOver(state, {origin: async () => { throw new Error("HOST_UNAVAILABLE"); }});
  const status = await offline.status(copy);
  assert.deepEqual({linked: status.linked, reason: status.reason, error: status.error}, {linked: {accountId: "personal", repoId: "7"}, reason: "linked", error: "HOST_UNAVAILABLE"});
  await assert.rejects(offline.originMatches(copy, sandbox), {message: "HOST_UNAVAILABLE"});
});

test("addresses that point inside the network are not probed", async () => {
  for (const origin of ["git@127.0.0.1:a/b.git", "https://169.254.169.254/a/b", "https://10.0.0.5/a/b", "git@localhost:a/b", "https://box.local/a/b", "https://[::1]/a/b"]) {
    const {links, calls} = setup(origin);
    const status = await links.status(copy);
    assert.equal(calls.probe, 0, origin);
    assert.equal(status.detection?.kind ?? null, null, origin);
  }
});

test("a server that has a configured account is known without probing, even on an internal name", async () => {
  const {links, calls} = setup("https://localhost:8443/stand/alpha.git", {
    accounts: async () => [{kind: "gitea", id: "local", label: "local", origin: "https://localhost:8443", organization: "", username: "stand"}],
    lookup: async (accountId, path) => ({target: {accountId, repoId: "5"}, clone: "https://localhost:8443/" + path + ".git"}),
  });
  const status = await links.status(copy);
  assert.deepEqual({kind: status.detection?.kind, state: status.detection?.status, origin: status.detection?.origin, linked: status.linked},
    {kind: "gitea", state: "known", origin: "https://localhost:8443", linked: {accountId: "local", repoId: "5"}});
  assert.equal(calls.probe, 0);
});

test("an https remote on another port of the same host is not taken for the configured server", async () => {
  const {links} = setup("https://localhost:9999/stand/alpha.git", {
    accounts: async () => [{kind: "gitea", id: "local", label: "local", origin: "https://localhost:8443", organization: "", username: "stand"}],
  });
  const status = await links.status(copy);
  assert.equal(status.detection?.kind ?? null, null);
  assert.equal(status.linked, null);
});
