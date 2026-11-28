import assert from "node:assert/strict";
import { test } from "node:test";
import { scaffoldCi } from "../src/core/scaffolds/ci.ts";
import type { Scaffold } from "../src/core/scaffolds/model.ts";

/** A scaffold with only what CI looks at: its files and its CI values. */
const scaffold = (ci: Scaffold["ci"]): Scaffold => ({id: "x", title: "X", description: "", params: [], files: [], ...(ci ? {ci} : {})});
const file = (path: string, text: string) => ({path, text, executable: false});
const python = [file("Makefile", "check: layout\n\t$(MAKE) -C src/service check\n"), file("src/service/Makefile", "check:\n\tuv run pytest\n"),
  file("src/service/pyproject.toml", "[project]\nname = \"svc\"\nrequires-python = \">=3.13\"\n\n[dependency-groups]\ndev = [\"pytest==9.2.0\"]\n\n[tool.uv]\npackage = false\n"),
  file("src/service/main.py", "")];
const go = (web: boolean) => [file("Makefile", "check: layout\n\t$(MAKE) -C src/service check\n"), file("src/service/go.mod", "module example.com/demo\n\ngo 1.26.0\n"),
  ...(web ? [file("src/frontend/package.json", "{\"name\": \"demo\", \"scripts\": {\"check\": \"vitest run\"}}\n")] : [])];
const plugin = [file("Makefile", "check:\n\tnpm run check\n"), file("package.json", "{\"name\": \"demo\", \"scripts\": {\"check\": \"tsc\"}, \"engines\": {\"node\": \">=22.18\"}}\n")];
const repo = {name: "demo", branch: "main"};
/** The CI file a scaffold gets; fails the test when it gets none. */
const ciOf = (...args: Parameters<typeof scaffoldCi>) => {
  const made = scaffoldCi(...args);
  if (!made || !("text" in made)) throw new Error("no CI file: " + JSON.stringify(made));
  return made;
};

test("the created project's CI comes from the CI template of its stack, with the scaffold's values on top", () => {
  const py = ciOf(python, scaffold({pythonTool: "uv", lockfile: false, make: true}), "github", repo);
  assert.equal(py.path, ".github/workflows/ci.yml");
  assert.equal(py.template, "python-github");
  assert.match(py.text, /run: pip install uv==0\.13\.10 && uv sync\n {8}working-directory: src\/service\n/);
  assert.match(py.text, /run: make check\n$/);

  const lab = ciOf(go(false), scaffold({make: true}), "gitlab", repo);
  assert.equal(lab.path, ".gitlab-ci.yml");
  assert.match(lab.text, /^ {4}- make check$/m);
  assert.doesNotMatch(lab.text, /^web:/m);

  const azure = ciOf(plugin, scaffold({packageManager: "npm", lockfile: false, make: true}), "azure", repo);
  assert.equal(azure.path, "azure-pipelines.yml");
  assert.match(azure.text, /- script: npm install\n/);
  assert.match(azure.text, /- script: make check\n {4}displayName: Check\n$/);
  assert.equal(ciOf(plugin, scaffold({make: true}), "gitea", repo).path, ".gitea/workflows/ci.yml");
});

test("no forge chosen means no CI file", () => {
  assert.equal(scaffoldCi(python, scaffold({make: true}), null, repo), null);
});

test("a Go service with its web UI in src/frontend/ gets Go's CI with Node.js: in the same job on Actions and Azure, in a job of its own on GitLab", () => {
  const github = ciOf(go(true), scaffold({make: true}), "github", repo);
  assert.equal(github.template, "go-github");
  assert.match(github.text, /go-version: "1\.26"/);
  assert.match(github.text, /- uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: "24"\n/);
  assert.match(github.text, /run: make check\n$/);
  const gitlab = ciOf(go(true), scaffold({make: true}), "gitlab", repo).text;
  assert.match(gitlab, /^ {4}- make check WEB=0$/m);
  assert.match(gitlab, /\nweb:\n {2}image: node:24\n {2}script:\n {4}- make web-check\n$/);
  assert.match(ciOf(go(true), scaffold({make: true}), "azure", repo).text, /- task: NodeTool@0\n {4}inputs:\n {6}versionSpec: "24\.x"\n/);
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

const frontend = [file("src/frontend/package.json", "{\"name\": \"demo\", \"engines\": {\"node\": \">=22.12\"}, \"scripts\": {\"check\": \"vitest run\", \"test\": \"vitest run\"}}\n"),
  file("src/frontend/Makefile", "check:\n\tnpm run check\n")];
const rootMake = file("Makefile", "check: layout\n\t$(MAKE) -C src/frontend check\n");

test("a frontend alone in src/frontend/ is a Node.js project: CI installs there and runs make check at the root", () => {
  const made = ciOf([rootMake, ...frontend], scaffold({packageManager: "npm", lockfile: false, make: true}), "github", repo);
  assert.equal(made.template, "node-github");
  assert.match(made.text, /- uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: "22"\n/);
  assert.match(made.text, /- name: Install\n {8}run: npm install\n {8}working-directory: src\/frontend\n/);
  assert.match(made.text, /- name: Check\n {8}run: make check\n$/);
});

test("Go in src/service/ with src/frontend/: Go's CI with the web UI", () => {
  const made = ciOf([...go(false), ...frontend], scaffold({make: true}), "github", repo);
  assert.equal(made.template, "go-github");
  assert.match(made.text, /- uses: actions\/setup-node@v4\n/);
});

test("Python in src/backend/ with src/frontend/: Python's CI with the web UI; without the frontend, none", () => {
  const backend = [file("Makefile", "check: layout\n\t$(MAKE) -C src/backend check\n"),
    file("src/backend/pyproject.toml", "[project]\nname = \"svc\"\nrequires-python = \">=3.13\"\n\n[tool.uv]\npackage = false\n")];
  const both = ciOf([...backend, ...frontend], scaffold({pythonTool: "uv", lockfile: false, make: true}), "github", repo);
  assert.equal(both.template, "python-github");
  assert.match(both.text, /- uses: actions\/setup-python@v5\n {8}with:\n {10}python-version: "3\.13"\n {6}- uses: actions\/setup-node@v4\n {8}with:\n {10}node-version: "24"\n/);
  assert.match(both.text, /run: pip install uv==0\.13\.10 && uv sync\n {8}working-directory: src\/backend\n/);
  const lab = ciOf([...backend, ...frontend], scaffold({pythonTool: "uv", lockfile: false, make: true}), "gitlab", repo);
  assert.match(lab.text, /^ {4}- make check WEB=0$/m);
  const alone = ciOf(backend, scaffold({pythonTool: "uv", lockfile: false, make: true}), "github", repo);
  assert.equal(alone.text.includes("setup-node"), false);
});

test("two applications besides the frontend in src/ get no CI file, and the reason names them", () => {
  const two = [rootMake, file("src/api/pyproject.toml", "[project]\nname = \"api\"\n"), file("src/worker/go.mod", "module example.com/w\n\ngo 1.26.0\n"), ...frontend];
  assert.deepEqual(scaffoldCi(two, scaffold({make: true}), "github", repo),
    {reason: "src/ holds more than one application (src/api: python, src/worker: go): choose their CI template in CI/CD → Templates"});
});
