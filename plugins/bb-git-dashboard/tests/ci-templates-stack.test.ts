import assert from "node:assert/strict";
import { test } from "node:test";
import { detectStacks, manifestPaths } from "../src/core/ci-templates/stack.ts";

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
  assert.deepEqual(uv, {id: "python", evidence: ["pyproject.toml", "uv.lock"], defaults: {pythonTool: "uv", pythonVersion: "3.13", test: true}});
  const [poetry] = detectStacks({paths: ["pyproject.toml"], manifests: {"pyproject.toml": "[tool.poetry]\nname = \"x\"\n"}});
  assert.deepEqual(poetry.defaults, {pythonTool: "poetry", pythonVersion: "3.12", test: false});
  const [pip] = detectStacks({paths: ["requirements.txt", ".python-version"], manifests: {".python-version": "3.11.9\n"}});
  assert.deepEqual(pip, {id: "python", evidence: ["requirements.txt"], defaults: {pythonTool: "pip", pythonVersion: "3.11", test: false}});
  const [plain] = detectStacks({paths: ["pyproject.toml"], manifests: {"pyproject.toml": "[project]\nname = \"x\"\n[tool.pytest.ini_options]\n"}});
  assert.deepEqual(plain.defaults, {pythonTool: "pyproject", pythonVersion: "3.12", test: true});
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
  assert.deepEqual(manifestPaths(["package.json", "src/a.ts", ".nvmrc", "pyproject.toml", "web/package.json", "go.mod", ".python-version"]),
    ["package.json", ".nvmrc", "pyproject.toml", "go.mod", ".python-version"]);
});
