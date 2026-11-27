import test from "node:test";
import assert from "node:assert/strict";
import { pickAccount, type GithubFacts } from "../src/core/forge/account-pick.ts";
import type { Detection } from "../src/core/forge/resolve.ts";
import type { Account } from "../src/core/providers.ts";

const github: Detection = {kind: "github", origin: "https://github.com", host: "github.com", status: "known"};
const gitea: Detection = {kind: "gitea", origin: "https://git.acme.example", host: "git.acme.example", status: "cached"};
const accounts: Account[] = [
  {kind: "github", id: "personal", label: "personal", origin: "https://github.com", organization: "", username: "Mesteriis"},
  {kind: "github", id: "office", label: "office", origin: "https://github.com", organization: "", username: "second-account"},
  {kind: "gitea", id: "acme", label: "acme", origin: "https://git.acme.example", organization: "", username: "avm"},
];
function facts(orgs: Record<string, string[]> = {}, visible: Record<string, string[]> = {}): GithubFacts & {calls: string[]} {
  const calls: string[] = [];
  return {
    calls,
    async orgs(id) { calls.push("orgs:" + id); if (id === "broken") throw new Error("PROVIDER_DENIED"); return orgs[id] ?? []; },
    async canSee(id, path) { calls.push("see:" + id); return (visible[id] ?? []).includes(path); },
  };
}

test("a GitHub repository owned by an account's login picks that account without API calls", async () => {
  const known = facts();
  assert.deepEqual(await pickAccount(github, "mesteriis/makosh-git-sandbox", accounts, known),
    {chosen: "personal", candidates: ["personal", "office"], reason: "owner"});
  assert.deepEqual(known.calls, []);
});

test("an organization repository picks the account that is a member", async () => {
  assert.deepEqual(await pickAccount(github, "office-org/app", accounts, facts({office: ["office-org"]})),
    {chosen: "office", candidates: ["personal", "office"], reason: "organization"});
});

test("a third-party repository picks the only account that can see it", async () => {
  assert.deepEqual(await pickAccount(github, "third/z", accounts, facts({}, {office: ["third/z"]})),
    {chosen: "office", candidates: ["personal", "office"], reason: "visible"});
});

test("two equally fitting accounts are not guessed", async () => {
  assert.deepEqual(await pickAccount(github, "third/z", accounts, facts({}, {personal: ["third/z"], office: ["third/z"]})),
    {chosen: null, candidates: ["personal", "office"], reason: "ambiguous"});
  assert.deepEqual(await pickAccount(github, "shared/z", accounts, facts({personal: ["shared"], office: ["shared"]})),
    {chosen: null, candidates: ["personal", "office"], reason: "ambiguous"});
});

test("a failing lookup for one account only rules that account out", async () => {
  const broken: Account[] = [{...accounts[0], id: "broken", username: "other"}, accounts[1]];
  assert.deepEqual(await pickAccount(github, "office-org/app", broken, facts({office: ["office-org"]})),
    {chosen: "office", candidates: ["broken", "office"], reason: "organization"});
});

test("other forges pick by server origin", async () => {
  assert.deepEqual(await pickAccount(gitea, "group/app", accounts, facts()), {chosen: "acme", candidates: ["acme"], reason: "host"});
  assert.deepEqual(await pickAccount({...gitea, origin: "https://git.dev.acme.example", host: "git.dev.acme.example"}, "g/a", accounts, facts()),
    {chosen: null, candidates: [], reason: "none"});
});

test("an unidentified forge has no candidates", async () => {
  assert.deepEqual(await pickAccount({kind: null, origin: null, host: "work-box", status: "unknown"}, "a/b", accounts, facts()),
    {chosen: null, candidates: [], reason: "none"});
});
