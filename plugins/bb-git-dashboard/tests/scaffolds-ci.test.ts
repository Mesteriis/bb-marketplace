import assert from "node:assert/strict";
import { test } from "node:test";
import { scaffoldCi } from "../src/core/scaffolds/ci.ts";
import { buildScaffold } from "../src/core/scaffolds/model.ts";
import { builtinScaffolds } from "../src/templates/scaffolds/index.ts";

const byId = (id: string) => builtinScaffolds.find(item => item.id === id)!;
const ci = (id: string, forge: Parameters<typeof scaffoldCi>[2], given = {}) => {
  const scaffold = byId(id);
  return scaffoldCi(buildScaffold(scaffold, given, {}).files, scaffold, forge, {name: "demo", branch: "main"});
};

test("the created project's CI comes from the CI template of its stack, with the scaffold's values on top", () => {
  const python = ci("python-service-uv", "github")!;
  assert.equal(python.path, ".github/workflows/ci.yml");
  assert.equal(python.template, "python-github");
  assert.match(python.text, /python-version: "3\.13"/);
  assert.match(python.text, /run: pip install uv && uv sync\n/);
  assert.match(python.text, /run: make check\n$/);

  const go = ci("go-service-with-web", "gitlab")!;
  assert.equal(go.path, ".gitlab-ci.yml");
  assert.match(go.text, /^ {2}image: golang:1\.26$/m);
  assert.match(go.text, /^ {4}- make check$/m);

  const plugin = ci("bb-plugin", "azure")!;
  assert.equal(plugin.path, "azure-pipelines.yml");
  assert.match(plugin.text, /versionSpec: "22\.x"/);
  assert.match(plugin.text, /- script: npm install\n/);
  assert.match(plugin.text, /- script: make check\n {4}displayName: Check\n$/);

  assert.equal(ci("bb-plugin", "gitea")!.path, ".gitea/workflows/ci.yml");
});

test("no forge chosen means no CI file", () => {
  assert.equal(ci("python-service-uv", null), null);
});
