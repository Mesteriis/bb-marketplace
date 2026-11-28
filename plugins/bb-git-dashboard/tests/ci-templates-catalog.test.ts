import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { builtinTemplates } from "../src/core/ci-templates/builtin.ts";
import type { Stack } from "../src/core/ci-templates/stack.ts";
import { offerTemplates, ownTemplates, templateDefaults } from "../src/core/ci-templates/catalog.ts";
import { renderTemplate, resolveValues, templateIssues, type CiTemplate, type CiValues } from "../src/core/ci-templates/render.ts";

const byId = (id: string) => builtinTemplates.find(template => template.id === id)!;

test("there is one built-in template per stack and forge, and every one passes the template checks", () => {
  const ids = builtinTemplates.map(template => template.id).sort();
  const expected = ["node", "python", "go", "rust", "docker"].flatMap(stack => ["github", "gitea", "gitlab", "azure"].map(forge => stack + "-" + forge)).sort();
  assert.deepEqual(ids, expected);
  for (const template of builtinTemplates) assert.deepEqual(templateIssues(template), [], template.id);
});

/** Every value of every choice and flag, one parameter at a time from the defaults. */
function variants(template: CiTemplate): CiValues[] {
  const defaults = resolveValues(template, {}, {});
  const out = [defaults];
  for (const param of template.params) {
    if (param.kind === "choice") for (const choice of param.choices) out.push({...defaults, [param.name]: choice});
    if (param.kind === "flag") out.push({...defaults, [param.name]: !defaults[param.name]});
  }
  return out;
}

test("every built-in template renders to YAML with no template tags left, for each choice and flag", () => {
  for (const template of builtinTemplates) for (const values of variants(template)) {
    const {text} = renderTemplate(template, values);
    assert.doesNotThrow(() => parse(text), template.id + " " + JSON.stringify(values));
    assert.doesNotMatch(text, /(?<!\$)\{\{/, template.id);
  }
});

test("Node on GitHub Actions with pnpm and a lockfile", () => {
  const template = byId("node-github");
  const values = resolveValues(template, {}, {packageManager: "pnpm", nodeVersion: "20", test: true, build: false, lint: false, lockfile: true});
  assert.deepEqual(renderTemplate(template, values), {path: ".github/workflows/ci.yml", text:
`# Node.js CI from a Makosh Git template. Add deployment and secrets yourself.
name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Enable pnpm
        run: npm install -g corepack && corepack enable
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Test
        run: pnpm run test
`});
  assert.equal(renderTemplate(byId("node-gitea"), values).path, ".gitea/workflows/ci.yml");
});

test("Python with uv on GitLab CI", () => {
  const template = byId("python-gitlab");
  assert.deepEqual(renderTemplate(template, resolveValues(template, {}, {pythonTool: "uv", pythonVersion: "3.13", test: true, lockfile: true})), {path: ".gitlab-ci.yml", text:
`# Python CI from a Makosh Git template. Add deployment and secrets yourself.
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == "main"
ci:
  image: python:3.13
  script:
    - pip install uv==0.13.10 && uv sync --locked
    - uv run pytest
`});
});

test("Go on Azure Pipelines, with the branch given", () => {
  const template = byId("go-azure");
  assert.deepEqual(renderTemplate(template, resolveValues(template, {branch: "trunk"}, {goVersion: "1.24"})), {path: "azure-pipelines.yml", text:
`# Go CI from a Makosh Git template. Add deployment and secrets yourself.
trigger:
  branches:
    include: [trunk]
pool:
  vmImage: ubuntu-latest
steps:
  - task: GoTool@0
    inputs:
      version: "1.24"
  - script: go build ./...
    displayName: Build
  - script: go vet ./...
    displayName: Vet
  - script: go test ./...
    displayName: Test
`});
});

const own = (id: string, stacks: CiTemplate["stacks"], title = "Own " + id): CiTemplate =>
  ({id, title, forge: "gitea", stacks, path: ".gitea/workflows/" + id + ".yml", params: [], body: "on: push\n"});

test("own templates come from a JSON list in the settings and from JSON files; broken ones are named with the reason", () => {
  assert.deepEqual(ownTemplates("settings", JSON.stringify([own("a", ["go"])])), [{source: "settings", name: "a", raw: own("a", ["go"])}]);
  assert.deepEqual(ownTemplates("settings", ""), []);
  assert.deepEqual(ownTemplates("settings", "{"), [{source: "settings", name: "settings", raw: null, error: "The CI templates setting is not a JSON list."}]);
  assert.deepEqual(ownTemplates("folder", JSON.stringify(own("b", [])), "b.json"), [{source: "folder", name: "b.json", raw: own("b", [])}]);
  assert.deepEqual(ownTemplates("folder", "nope", "c.json"), [{source: "folder", name: "c.json", raw: null, error: "The file is not JSON."}]);
});

test("offered templates are the forge's: those of the found stacks first, in the stacks' order, own ones before built-in", () => {
  const {offered, rejected} = offerTemplates("gitea", [{id: "go", evidence: ["go.mod"], defaults: {}}, {id: "docker", evidence: ["Dockerfile"], defaults: {}}], [
    {source: "settings", name: "mine", raw: own("mine", ["docker"])},
    {source: "folder", name: "x.json", raw: {...own("x", []), forge: "gitlab", path: ".gitlab-ci.yml"}},
    {source: "folder", name: "bad.json", raw: {...own("bad", []), body: "{{nope}}\n"}},
    {source: "folder", name: "broken.json", raw: null, error: "The file is not JSON."},
  ]);
  assert.deepEqual(offered.map(entry => [entry.key, entry.matches]), [
    ["builtin:go-gitea", true], ["settings:mine", true], ["builtin:docker-gitea", true],
    ["builtin:node-gitea", false], ["builtin:python-gitea", false], ["builtin:rust-gitea", false],
  ]);
  assert.deepEqual(rejected, [
    {source: "folder", name: "bad.json", issues: ["The template does not render: unknown name nope."]},
    {source: "folder", name: "broken.json", issues: ["The file is not JSON."]},
  ]);
});

test("a template's suggested values are those of its own stacks, then the repository's branch and name", () => {
  const stacks: Stack[] = [{id: "node", evidence: [], defaults: {test: false, packageManager: "pnpm"}}, {id: "python", evidence: [], defaults: {test: true, pythonTool: "uv"}}];
  assert.deepEqual(templateDefaults(byId("node-github"), stacks, {branch: "trunk", name: "My App"}), {test: false, packageManager: "pnpm", branch: "trunk", image: "my-app", make: false});
  assert.deepEqual(templateDefaults(byId("python-github"), stacks, {branch: null, name: "x"}), {test: true, pythonTool: "uv", branch: "main", image: "x", make: false});
  assert.deepEqual(templateDefaults(byId("go-github"), stacks, {branch: "main", name: "--", make: true}), {branch: "main", image: "app", make: true});
});

test("without a committed uv.lock, uv syncs without --locked", () => {
  const template = byId("python-github");
  const {text} = renderTemplate(template, resolveValues(template, {}, {pythonTool: "uv", lockfile: false}));
  assert.match(text, /run: pip install uv==0\.13\.10 && uv sync\n/);
  assert.doesNotMatch(text, /--locked/);
});

test("with a Makefile that has a check target, CI sets up the language and runs make check instead of the steps", () => {
  const template = byId("go-github");
  const {text} = renderTemplate(template, resolveValues(template, {}, {goVersion: "1.26", make: true}));
  assert.equal(text.split("\n").slice(-3).join("\n"), "      - name: Check\n        run: make check\n");
  assert.doesNotMatch(text, /go vet/);
  const node = byId("node-gitlab");
  const nodeText = renderTemplate(node, resolveValues(node, {}, {packageManager: "npm", lockfile: true, make: true})).text;
  assert.match(nodeText, /    - npm ci\n    - make check\n$/);
});
