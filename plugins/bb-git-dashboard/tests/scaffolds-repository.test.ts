import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryLine, validOwner } from "../src/core/scaffolds/repository.ts";

test("the owner of a new repository fits its forge: an organization, a group path, an Azure project; empty is the account's user", () => {
  assert.equal(validOwner("github", null), true);
  assert.equal(validOwner("github", "team-1"), true);
  assert.equal(validOwner("github", "team/sub"), false);
  assert.equal(validOwner("gitea", "my.org"), true);
  assert.equal(validOwner("gitlab", "team/sub-group"), true);
  assert.equal(validOwner("gitlab", "team/../x"), false);
  assert.equal(validOwner("gitlab", "/team"), false);
  assert.equal(validOwner("azure", null), false);
  assert.equal(validOwner("azure", "Tools and Docs"), true);
  assert.equal(validOwner("azure", "a/b"), false);
  assert.equal(validOwner("azure", ".."), false);
});

test("the preview says where the repository goes and whether it is private, in words", () => {
  const account = {kind: "github" as const, label: "Work", username: "octo"};
  assert.equal(repositoryLine(account, {owner: null, visibility: "private"}, "notes"), "New repository · Work (github) · octo/notes · private");
  assert.equal(repositoryLine(account, {owner: "team", visibility: "public"}, "notes"), "New repository · Work (github) · team/notes · PUBLIC: anyone can read it");
  assert.equal(repositoryLine({kind: "azure", label: "AZ", username: "octo"}, {owner: "Tools", visibility: "private"}, "notes"),
    "New repository · AZ (azure) · Tools/notes · private (as the Azure project Tools, checked)");
  assert.equal(repositoryLine({kind: "azure", label: "AZ", username: "octo"}, {owner: "Open", visibility: "public"}, "notes"),
    "New repository · AZ (azure) · Open/notes · PUBLIC: anyone can read it (as the Azure project Open, checked)");
});
