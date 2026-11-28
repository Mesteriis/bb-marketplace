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
  assert.match(python.text, /run: pip install uv==0\.13\.10 && uv sync\n/);
  assert.match(python.text, /run: make check\n$/);

  const go = ci("go-service-with-web", "gitlab", {web: false})!;
  assert.equal(go.path, ".gitlab-ci.yml");
  assert.match(go.text, /^ {2}image: golang:1\.26$/m);
  assert.match(go.text, /^ {4}- make check$/m);
  assert.doesNotMatch(go.text, /^web:/m);

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

test("a Go project with web/ gets Node.js for it: in the same job on Actions and Azure, in a job of its own on GitLab", () => {
  const gitlab = ci("go-service-with-web", "gitlab")!.text;
  assert.match(gitlab, /^ {4}- make check WEB=0$/m);
  assert.match(gitlab, /\nweb:\n {2}image: node:24\n {2}script:\n {4}- make web-check\n$/);
  const github = ci("go-service-with-web", "github")!.text;
  assert.match(github, /- uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: "24"\n/);
  assert.match(github, /run: make check\n$/);
  assert.match(ci("go-service-with-web", "azure")!.text, /- task: NodeTool@0\n {4}inputs:\n {6}versionSpec: "24\.x"\n/);
});

test("the CI templates install uv and Poetry at the versions they were checked with, as the actions are pinned", async () => {
  const {builtinTemplates} = await import("../src/core/ci-templates/builtin.ts");
  const {renderTemplate, resolveValues} = await import("../src/core/ci-templates/render.ts");
  const python = builtinTemplates.find(item => item.id === "python-github")!;
  const poetry = renderTemplate(python, resolveValues(python, {pythonTool: "poetry"}, {})).text;
  assert.match(poetry, /run: pip install poetry==2\.5\.2 && poetry install --no-interaction\n/);
  const gitlab = builtinTemplates.find(item => item.id === "python-gitlab")!;
  assert.match(renderTemplate(gitlab, resolveValues(gitlab, {pythonTool: "uv", lockfile: false}, {})).text, /- pip install uv==0\.13\.10 && uv sync\n/);
  for (const template of builtinTemplates) assert.doesNotMatch(template.body, /pip install (uv|poetry)(?!==)/, template.id);
});

test("an application under src/<role>/ installs and checks there; make check stays at the root", async () => {
  const {builtinTemplates} = await import("../src/core/ci-templates/builtin.ts");
  const {templateDefaults} = await import("../src/core/ci-templates/catalog.ts");
  const {renderTemplate, resolveValues} = await import("../src/core/ci-templates/render.ts");
  const {detectStacks} = await import("../src/core/ci-templates/stack.ts");
  const stacks = detectStacks({paths: ["Makefile", "src/service/pyproject.toml"], manifests: {"src/service/pyproject.toml": "[project]\n\n[dependency-groups]\ndev = [\"pytest==9.2.0\"]\n\n[tool.uv]\npackage = false\n"}});
  const github = builtinTemplates.find(item => item.id === "python-github")!;
  const suggested = templateDefaults(github, stacks, {branch: "main", name: "svc", make: true});
  assert.equal(suggested.appDir, "src/service");
  assert.equal(suggested.inApp, true);
  const actions = renderTemplate(github, resolveValues(github, {}, suggested)).text;
  assert.match(actions, /- name: Install\n {8}run: pip install uv==0\.13\.10 && uv sync\n {8}working-directory: src\/service\n/);
  assert.match(actions, /- name: Check\n {8}run: make check\n$/);
  const gitlab = builtinTemplates.find(item => item.id === "python-gitlab")!;
  const lab = renderTemplate(gitlab, resolveValues(gitlab, {}, templateDefaults(gitlab, stacks, {branch: "main", name: "svc", make: true}))).text;
  assert.match(lab, /^ {4}- \(cd src\/service && pip install uv==0\.13\.10 && uv sync\)$/m);
  assert.match(lab, /^ {4}- make check$/m);
  const azure = builtinTemplates.find(item => item.id === "python-azure")!;
  assert.match(renderTemplate(azure, resolveValues(azure, {}, templateDefaults(azure, stacks, {branch: "main", name: "svc", make: false}))).text,
    /- script: uv run pytest\n {4}displayName: Test\n {4}workingDirectory: src\/service\n/);
  // A project at the root renders as before: no working directory anywhere.
  const rooted = renderTemplate(github, resolveValues(github, {pythonTool: "uv"}, {})).text;
  assert.doesNotMatch(rooted, /working-directory/);
  assert.throws(() => resolveValues(github, {appDir: "../out", inApp: true}, {}));
});
