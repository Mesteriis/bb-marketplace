import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { account, sourceOf } from "../src/core/providers.ts";
import { detectProvider } from "../src/core/connection.ts";
import { capabilities, limitation } from "../src/core/forge/capabilities.ts";
import { provider } from "../src/adapters/bb/provider.ts";
import { providerCredentials } from "../src/adapters/bb/provider-credentials.ts";

// The shape of accounts saved by 0.1.0; reference values computed with the 0.1.0 code.
const installed = '[{"kind":"github","id":"11111111-2222-4333-8444-555555555555","label":"personal","origin":"https://github.com","organization":"","username":"Octo-Owner"},{"kind":"github","id":"66666666-7777-4888-9999-aaaaaaaaaaaa","label":"office","origin":"https://github.com","organization":"","username":"work-login"}]';

test("accounts saved by 0.1.0 parse unchanged and default to the Vault token source", () => {
  const rows = z.array(account).parse(JSON.parse(installed));
  assert.deepEqual(rows.map(row => [row.username, sourceOf(row)]), [["Octo-Owner", "vault"], ["work-login", "vault"]]);
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
  assert.equal(ref, "bb-git-dashboard:provider:v1:cf4c4732fd3b8f8a55b60871950a2f22c893ea7afd75d2146826534e3f67cc49");
  assert.equal(JSON.parse(secret).binding, "4e5187ffa5f18fa1cf5fab5673337d5f7d601c866af74c15c989e6817a5779af");
});

test("gitlab.com remotes are detected as GitLab", () => {
  assert.deepEqual(detectProvider("https://gitlab.com/group/project"), {kind: "gitlab", origin: "https://gitlab.com", organization: ""});
  assert.deepEqual(detectProvider("git@gitlab.com:group/project.git"), {kind: "gitlab", origin: "https://gitlab.com", organization: ""});
});

test("GitLab accounts get an API client", () => {
  const gitlab = account.parse({kind: "gitlab", id: "g", label: "GitLab", origin: "https://gitlab.com", username: "octo-owner"});
  assert.equal(typeof provider(gitlab, "fixture-token-value").repositories, "function");
});

test("capabilities state what each forge offers in this release", () => {
  assert.deepEqual(capabilities("gitlab"), {repositories: true, pulls: true, pipelines: true, issues: true, variables: true});
  assert.deepEqual(capabilities("github"), {repositories: true, pulls: true, pipelines: true, issues: true, variables: true});
  assert.equal(capabilities("azure").issues, false);
  assert.equal(limitation("azure", "issues"), "Azure Boards are scoped to the Azure DevOps project.");
  assert.equal(limitation("github", "issues"), null);
  assert.equal(limitation("gitlab", "issues"), null);
});
