import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { buildScaffold, scaffoldIssues, variants } from "../src/core/scaffolds/model.ts";
import { commonParams } from "../src/core/scaffolds/overlay.ts";
import { builtinScaffolds } from "../src/templates/scaffolds/index.ts";

const byId = (id: string) => builtinScaffolds.find(item => item.id === id)!;
const file = (files: {path: string; text: string}[], path: string) => files.find(item => item.path === path)?.text;

test("the first three scaffolds are offered and each passes the scaffold checks", () => {
  assert.deepEqual(builtinScaffolds.map(item => item.id), ["python-service-uv", "go-service-with-web", "bb-plugin"]);
  for (const scaffold of builtinScaffolds) assert.deepEqual(scaffoldIssues(scaffold), [], scaffold.id);
});

test("for every choice and flag, the JSON files parse, the YAML files parse, no template tag is left and free text is escaped", () => {
  for (const scaffold of builtinScaffolds) for (const values of variants([...commonParams, ...scaffold.params])) {
    const tricky = {...values, description: "Says \"hi\" \\ to: you # not a comment", author: "O'Brien & Co"};
    const {files} = buildScaffold(scaffold, tricky, {});
    for (const {path, text} of files) {
      const where = scaffold.id + " " + path + " " + JSON.stringify(values);
      assert.doesNotMatch(text, /(?<!\$)\{\{/, where);
      if (path.endsWith(".json")) assert.doesNotThrow(() => JSON.parse(text), where);
      if (/\.ya?ml$/.test(path)) assert.doesNotThrow(() => parse(text), where);
      assert.ok(text.endsWith("\n"), "ends with a newline: " + where);
    }
  }
});

test("python-service-uv: FastAPI with Docker, MIT, the description escaped in pyproject.toml", () => {
  const {files} = buildScaffold(byId("python-service-uv"), {name: "notes-api", package: "notes", variant: "fastapi", docker: true,
    description: "Notes \"API\""}, {});
  const pyproject = file(files, "pyproject.toml")!;
  assert.match(pyproject, /^name = "notes-api"$/m);
  assert.match(pyproject, /^description = "Notes \\"API\\""$/m);
  assert.match(pyproject, /^requires-python = ">=3\.13"$/m);
  assert.match(pyproject, /^license = "MIT"\nlicense-files = \["LICENSE"\]$/m);
  assert.match(pyproject, /^ {4}"fastapi==0\.165\.0",\n {4}"uvicorn==0\.54\.0",\n\]$/m);
  assert.match(pyproject, /^"notes-api" = "notes\.__main__:main"$/m);
  assert.match(pyproject, /^packages = \["src\/notes"\]$/m);
  assert.ok(file(files, "src/notes/app.py") && file(files, "tests/test_app.py") && !file(files, "src/notes/service.py"));
  assert.match(file(files, "Dockerfile")!, /^FROM python:3\.13-slim AS build$/m);
  assert.match(file(files, "Dockerfile")!, /^USER 10001:10001$/m);
  assert.match(file(files, "Makefile")!, /^check: lint test$/m);
  assert.equal(file(files, ".env.example"), "# Copy to .env for local runs; never commit .env.\n# Address and port to listen on (default 127.0.0.1:8000).\nAPP_HOST=\nAPP_PORT=\n");
  assert.throws(() => buildScaffold(byId("python-service-uv"), {package: "Notes-App"}, {}), /TEMPLATE_INVALID/);
});

test("go-service-with-web: the module path and command name, web/ only with its flag, make check covering the web", () => {
  const withWeb = buildScaffold(byId("go-service-with-web"), {module: "example.org/team/tool", binary: "tool"}, {}).files;
  assert.equal(file(withWeb, "go.mod"), "module example.org/team/tool\n\ngo 1.26.0\n\ntoolchain go1.27.4\n");
  assert.match(file(withWeb, "cmd/tool/main.go")!, /^\t"example\.org\/team\/tool\/internal\/server"$/m);
  assert.match(file(withWeb, "Makefile")!, /^CHECKS := fmt-check vet lint test vuln\nifneq \(\$\(WEB\),0\)\nCHECKS \+= web-check\nendif\n\ncheck: \$\(CHECKS\)$/m);
  assert.match(file(withWeb, "Makefile")!, /https:\/\/raw\.githubusercontent\.com\/golangci\/golangci-lint\/\$\(GOLANGCI_LINT_VERSION\)\/install\.sh/);
  assert.equal(JSON.parse(file(withWeb, "web/package.json")!).devDependencies.typescript, "~6.0.3");
  const plain = buildScaffold(byId("go-service-with-web"), {web: false}, {}).files;
  assert.ok(!plain.some(item => item.path.startsWith("web/")));
  assert.match(file(plain, "Makefile")!, /^CHECKS := fmt-check vet lint test vuln\n\ncheck: \$\(CHECKS\)$/m);
  const docker = buildScaffold(byId("go-service-with-web"), {docker: true}, {}).files;
  assert.match(file(docker, "Dockerfile")!, /^COPY web\/package\*\.json \.\/\nRUN if \[ -f package-lock\.json \]; then npm ci; else npm install; fi$/m);
  assert.doesNotMatch(file(plain, "Makefile")!, /web-check:/);
  assert.throws(() => buildScaffold(byId("go-service-with-web"), {module: "Example.org/x"}, {}), /TEMPLATE_INVALID/);
});

test("bb-plugin: the bb field lists the chosen entries, the license is SPDX or UNLICENSED, host code stays out of core and ui", () => {
  const built = buildScaffold(byId("bb-plugin"), {name: "bb-plugin-notes", displayName: "Notes \"pro\"", host: true, license: "none"}, {}).files;
  const pkg = JSON.parse(file(built, "package.json")!);
  assert.deepEqual(pkg.bb, {name: "Notes \"pro\"", description: "", branding: {icon: "Puzzle"}, app: "./app.tsx", host: "./host.ts", server: "./server.ts"});
  assert.equal(pkg.license, "UNLICENSED");
  assert.equal(pkg.devDependencies["@get-bb/plugin-sdk"], "0.6.157");
  assert.equal(pkg.engines.bbPluginSdk, ">=0.6.157");
  assert.equal(JSON.parse(file(buildScaffold(byId("bb-plugin"), {sdk: "0.6.205"}, {}).files, "package.json")!).devDependencies["@get-bb/plugin-sdk"], "0.6.205");
  assert.throws(() => buildScaffold(byId("bb-plugin"), {sdk: "latest"}, {}), /TEMPLATE_INVALID/);
  assert.ok(!built.some(item => item.path === "LICENSE"));
  for (const item of built.filter(entry => /^src\/(core|ui)\//.test(entry.path)))
    assert.doesNotMatch(item.text, /from\s*["'](?:node:|@get-bb\/)/, item.path);
  const noApp = buildScaffold(byId("bb-plugin"), {app: false}, {}).files;
  assert.deepEqual(JSON.parse(file(noApp, "package.json")!).bb, {name: "My plugin", description: "", branding: {icon: "Puzzle"}, server: "./server.ts"});
  assert.ok(!noApp.some(item => item.path === "app.tsx" || item.path.startsWith("src/ui/")));
});
