import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { account, sourceOf } from "../src/core/providers.ts";
import { detectProvider } from "../src/core/connection.ts";
import { capabilities, limitation } from "../src/core/forge/capabilities.ts";
import { provider } from "../src/adapters/bb/provider.ts";
import { providerCredentials } from "../src/adapters/bb/provider-credentials.ts";

// The exact JSON stored in the maintainer's installation before 0.2.0.
const installed = '[{"kind":"github","id":"afca39a3-8243-4cf9-bbe2-fb018fbdb406","label":"personal","origin":"https://github.com","organization":"","username":"Mesteriis"},{"kind":"github","id":"fbd507f6-fd73-4c22-b061-19a0801fa119","label":"office","origin":"https://github.com","organization":"","username":"second-account"}]';

test("accounts saved by 0.1.0 parse unchanged and default to the Vault token source", () => {
  const rows = z.array(account).parse(JSON.parse(installed));
  assert.deepEqual(rows.map(row => [row.username, sourceOf(row)]), [["Mesteriis", "vault"], ["second-account", "vault"]]);
  // Linked repositories are matched by this exact JSON stamp.
  assert.equal(JSON.stringify(rows), installed);
});

test("the Vault reference and binding of an existing account do not change", async () => {
  const stored = new Map<string, string>();
  const credentials = providerCredentials({
    enabled: async () => true,
    get: async ref => stored.get(ref) ?? null,
    putIfAbsent: async (ref, secret) => { stored.set(ref, secret); },
  }, {get: async () => undefined, set: async () => {}});
  const [first] = z.array(account).parse(JSON.parse(installed));
  await credentials.resolve(first, () => "token-value");
  const [[ref, secret]] = [...stored];
  assert.equal(ref, "bb-git-dashboard:provider:v1:c27daf2e610a8539317a337bfcb53c3e0bec778d7905a457aa362eee9f26e696");
  assert.equal(JSON.parse(secret).binding, "22c8348b61363dbc02faa2a9dbf6a345fd4d539a46fbb5a94848d76e2b9ea7f5");
});

test("gitlab.com remotes are detected as GitLab", () => {
  assert.deepEqual(detectProvider("https://gitlab.com/group/project"), {kind: "gitlab", origin: "https://gitlab.com", organization: ""});
  assert.deepEqual(detectProvider("git@gitlab.com:group/project.git"), {kind: "gitlab", origin: "https://gitlab.com", organization: ""});
});

test("GitLab accounts are declared but have no API client yet", () => {
  const gitlab = account.parse({kind: "gitlab", id: "g", label: "GitLab", origin: "https://gitlab.com", username: "mesteriis"});
  assert.throws(() => provider(gitlab, "token"), /PROVIDER_UNSUPPORTED/);
});

test("capabilities state what each forge offers in this release", () => {
  assert.deepEqual(capabilities("gitlab"), {repositories: false, pulls: false, pipelines: false, issues: false, variables: false});
  assert.deepEqual(capabilities("github"), {repositories: true, pulls: true, pipelines: true, issues: true, variables: true});
  assert.equal(capabilities("azure").issues, false);
  assert.equal(limitation("azure", "issues"), "Azure Boards are scoped to the Azure DevOps project.");
  assert.equal(limitation("github", "issues"), null);
  assert.equal(limitation("gitlab", "pipelines"), "GitLab support arrives in a later release.");
});
