import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStacks, makeCheck, manifestPaths } from "../src/core/ci-templates/stack.ts";

test("a Node project: the package manager from the packageManager field, the version from .nvmrc, scripts as flags", () => {
  const stacks = detectStacks({
    paths: ["package.json", "pnpm-lock.yaml", ".nvmrc", "src/index.ts"],
    manifests: {"package.json": JSON.stringify({packageManager: "pnpm@9.12.0", scripts: {test: "vitest", build: "tsc"}}), ".nvmrc": "v20.11.1\n"},
  });
  assert.deepEqual(stacks, [{id: "node", evidence: ["package.json", "pnpm-lock.yaml"],
    defaults: {packageManager: "pnpm", nodeVersion: "20", test: true, build: true, lint: false, lockfile: true}}]);
});

test("Node without packageManager takes the lockfile, and the engines range when there is no version file", () => {
  const [yarn] = detectStacks({paths: ["package.json", "yarn.lock"], manifests: {"package.json": JSON.stringify({engines: {node: ">=22.18"}, scripts: {lint: "eslint ."}})}});
  assert.deepEqual(yarn.defaults, {packageManager: "yarn", nodeVersion: "22", test: false, build: false, lint: true, lockfile: true});
  const [bun] = detectStacks({paths: ["package.json", "bun.lock"], manifests: {"package.json": "{}"}});
  assert.equal(bun.defaults.packageManager, "bun");
  const [plain] = detectStacks({paths: ["package.json"], manifests: {"package.json": "not json"}});
  assert.deepEqual(plain.defaults, {packageManager: "npm", nodeVersion: "22", test: false, build: false, lint: false, lockfile: false});
});

test("a Python project: uv by its lockfile, poetry by its section, the version from requires-python, pytest as the test flag", () => {
  const [uv] = detectStacks({paths: ["pyproject.toml", "uv.lock", "tests/test_app.py"],
    manifests: {"pyproject.toml": "[project]\nname = \"x\"\nrequires-python = \">=3.13\"\n[dependency-groups]\ndev = [\"pytest>=8\"]\n"}});
  assert.deepEqual(uv, {id: "python", evidence: ["pyproject.toml", "uv.lock"], defaults: {pythonTool: "uv", pythonVersion: "3.13", test: true, lockfile: true}});
  const [poetry] = detectStacks({paths: ["pyproject.toml"], manifests: {"pyproject.toml": "[tool.poetry]\nname = \"x\"\n"}});
  assert.deepEqual(poetry.defaults, {pythonTool: "poetry", pythonVersion: "3.12", test: false, lockfile: false});
  // A project uv manages before its first lock: its [tool.uv] table says so.
  const [unlocked] = detectStacks({paths: ["pyproject.toml"], manifests: {"pyproject.toml": "[project]\nname = \"x\"\n\n[tool.uv]\npackage = false\n"}});
  assert.deepEqual(unlocked.defaults, {pythonTool: "uv", pythonVersion: "3.12", test: false, lockfile: false});
  const [pip] = detectStacks({paths: ["requirements.txt", ".python-version"], manifests: {".python-version": "3.11.9\n"}});
  assert.deepEqual(pip, {id: "python", evidence: ["requirements.txt"], defaults: {pythonTool: "pip", pythonVersion: "3.11", test: false, lockfile: false}});
  const [plain] = detectStacks({paths: ["pyproject.toml"], manifests: {"pyproject.toml": "[project]\nname = \"x\"\n[tool.pytest.ini_options]\n"}});
  assert.deepEqual(plain.defaults, {pythonTool: "pyproject", pythonVersion: "3.12", test: true, lockfile: false});
});

test("Go takes its version from go.mod, Rust is found by Cargo.toml, Docker by a Dockerfile at the root", () => {
  const stacks = detectStacks({paths: ["go.mod", "Cargo.toml", "Dockerfile", "main.go"], manifests: {"go.mod": "module example.org/x\n\ngo 1.24.2\n", "Cargo.toml": "[package]\nname = \"x\"\n"}});
  assert.deepEqual(stacks, [
    {id: "go", evidence: ["go.mod"], defaults: {goVersion: "1.24"}},
    {id: "rust", evidence: ["Cargo.toml"], defaults: {}},
    {id: "docker", evidence: ["Dockerfile"], defaults: {}},
  ]);
});

test("only files at the root count, and a project with none of them has no stack", () => {
  assert.deepEqual(detectStacks({paths: ["web/package.json", "svc/go.mod", "docs/Dockerfile", "README.md"], manifests: {}}), []);
});

test("the manifests to read are the root ones the project has", () => {
  assert.deepEqual(manifestPaths(["package.json", "src/a.ts", ".nvmrc", "pyproject.toml", "web/package.json", "go.mod", ".python-version", "Makefile"]),
    ["package.json", ".nvmrc", "pyproject.toml", "go.mod", ".python-version", "Makefile"]);
});

test("a root Makefile with a check target makes CI run make check", () => {
  assert.equal(makeCheck({paths: ["Makefile"], manifests: {Makefile: ".PHONY: check\ncheck: lint test\n\tgo vet ./...\n"}}), true);
  assert.equal(makeCheck({paths: ["Makefile"], manifests: {Makefile: "build:\n\tgo build\n# check: not a target\n"}}), false);
  assert.equal(makeCheck({paths: ["src/Makefile"], manifests: {}}), false);
});

test("with nothing at the root, the application under src/<role>/ is the stack, with its folder; a root stack wins", () => {
  const input = {paths: ["Makefile", "scripts", "src", "src/service/Makefile", "src/service/pyproject.toml"],
    manifests: {"src/service/pyproject.toml": "[project]\nname = \"x\"\nrequires-python = \">=3.13\"\n\n[tool.uv]\npackage = false\n"}};
  assert.deepEqual(detectStacks(input), [{id: "python", dir: "src/service", evidence: ["src/service/pyproject.toml"],
    defaults: {pythonTool: "uv", pythonVersion: "3.13", test: false, lockfile: false}}]);
  const front = detectStacks({paths: ["src/frontend/package.json", "src/frontend/pnpm-lock.yaml"], manifests: {"src/frontend/package.json": "{\"scripts\":{\"test\":\"vitest\"}}"}});
  assert.deepEqual([front[0]!.id, front[0]!.dir, front[0]!.defaults.packageManager, front[0]!.defaults.lockfile], ["node", "src/frontend", "pnpm", true]);
  const go = detectStacks({paths: ["src/service/go.mod"], manifests: {"src/service/go.mod": "module x\n\ngo 1.26.0\n"}});
  assert.deepEqual([go[0]!.id, go[0]!.dir, go[0]!.defaults.goVersion], ["go", "src/service", "1.26"]);
  const root = detectStacks({paths: ["pyproject.toml", "src/web/package.json"], manifests: {"pyproject.toml": "[project]\n", "src/web/package.json": "{}"}});
  assert.deepEqual(root.map(stack => [stack.id, stack.dir]), [["python", undefined]]);
  // A folder deeper than src/<role>/ is not an application root.
  assert.deepEqual(detectStacks({paths: ["src/a/b/pyproject.toml"], manifests: {}}), []);
  assert.deepEqual(manifestPaths(["Makefile", "src/service/pyproject.toml", "src/service/main.py", "src/a/b/go.mod", "src/x/package.json"]),
    ["Makefile", "src/service/pyproject.toml", "src/x/package.json"]);
});
