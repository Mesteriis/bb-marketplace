import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { buildScaffold, scaffoldIssues, variants } from "../src/core/scaffolds/model.ts";
import { commonParams } from "../src/core/scaffolds/overlay.ts";
import { builtinScaffolds } from "../src/templates/scaffolds/index.ts";

const byId = (id: string) => builtinScaffolds.find(item => item.id === id)!;
const file = (files: {path: string; text: string}[], path: string) => files.find(item => item.path === path)?.text;

test("the built-in scaffolds are offered and each passes the scaffold checks", () => {
  assert.deepEqual(builtinScaffolds.map(item => item.id), ["python-service-uv", "django-uv", "go-service-with-web", "bb-plugin"]);
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
  assert.match(pyproject, /^\[tool\.uv\]\nrequired-version = ">=0\.5\.14"$/m);
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

test("python-service-uv: the aiogram bot — its router, the token from the environment, the toolkit's tests with pytest-asyncio", () => {
  const {files} = buildScaffold(byId("python-service-uv"), {name: "echo-bot", package: "echo", variant: "aiogram"}, {});
  const pyproject = file(files, "pyproject.toml")!;
  assert.match(pyproject, /^dependencies = \[\n {4}"aiogram==3\.34\.0",\n\]$/m);
  assert.match(pyproject, /^ {4}"aiogram\[test\]==3\.34\.0",$/m);
  assert.match(pyproject, /^ {4}"pytest-asyncio==1\.5\.0",$/m);
  assert.match(pyproject, /^\[tool\.pytest\]\naddopts = \["-ra", "--strict-markers"\]\ntestpaths = \["tests"\]\nasyncio_mode = "auto"\nasyncio_default_fixture_loop_scope = "function"$/m);
  assert.ok(file(files, "src/echo/bot.py") && file(files, "tests/test_bot.py"));
  assert.ok(!file(files, "src/echo/service.py") && !file(files, "src/echo/app.py"));
  assert.match(file(files, "src/echo/bot.py")!, /^def create_router\(\) -> Router:$/m);
  assert.match(file(files, "tests/test_bot.py")!, /^def bot_dispatcher\(\) -> Dispatcher:$/m);
  assert.equal(file(files, ".env.example"), "# Copy to .env for local runs; never commit .env.\n# The bot's token from @BotFather (required).\nBOT_TOKEN=\n");
  // The plain service has no aiogram in it.
  assert.doesNotMatch(file(buildScaffold(byId("python-service-uv"), {}, {}).files, "pyproject.toml")!, /aiogram|pytest-asyncio|asyncio_mode/);
});

test("django-uv: Django 6.1 on uv with Ruff, mypy and django-stubs, pytest-django, the migration check in make check", () => {
  const {files} = buildScaffold(byId("django-uv"), {name: "shop", project: "config"}, {});
  const pyproject = file(files, "pyproject.toml")!;
  assert.match(pyproject, /^dependencies = \[\n {4}"django==6\.1\.3",\n\]$/m);
  assert.match(pyproject, /^ {4}"django-stubs\[compatible-mypy\]==6\.1\.2",$/m);
  assert.match(pyproject, /^ {4}"pytest-django==4\.14\.0",$/m);
  // The lowest uv with everything the file uses: [tool.uv] required-version came in uv 0.5.14.
  assert.match(pyproject, /^\[tool\.uv\]\npackage = false\nrequired-version = ">=0\.5\.14"$/m);
  assert.match(pyproject, /^\[tool\.mypy\]\nstrict = true\nwarn_unreachable = true\nplugins = \["mypy_django_plugin\.main"\]$/m);
  assert.match(pyproject, /^\[tool\.django-stubs\]\ndjango_settings_module = "config\.test_settings"$/m);
  assert.match(pyproject, /^DJANGO_SETTINGS_MODULE = "config\.test_settings"$/m);
  assert.doesNotMatch(pyproject, /tool\.poetry|celery|gunicorn|pylint|bandit/);
  for (const path of ["manage.py", "config/__init__.py", "config/settings.py", "config/test_settings.py", "config/urls.py", "config/asgi.py",
    "config/wsgi.py", "core/__init__.py", "core/apps.py", "core/views.py", "tests/test_health.py"]) assert.ok(file(files, path), path);
  assert.ok(!file(files, "config/celery.py") && !file(files, "Dockerfile"));
  assert.match(file(files, "Makefile")!, /^RUN := uv run$/m);
  assert.match(file(files, "Makefile")!, /^check: lint test migrations$/m);
  assert.match(file(files, "Makefile")!, /^migrations:\n\t\$\(RUN\) python manage\.py makemigrations --check \$\(TEST_SETTINGS\)$/m);
  assert.match(file(files, "Makefile")!, /^deploy-check:\n\t\$\(RUN\) python manage\.py check --deploy$/m);
  assert.equal(file(files, "manage.py")!.split("\n")[0], "#!/usr/bin/env python");
  assert.match(file(files, "config/settings.py")!, /^SECRET_KEY = os\.environ\.get\("DJANGO_SECRET_KEY", ""\)$/m);
  assert.match(file(files, ".gitignore")!, /^db\.sqlite3$/m);
  assert.throws(() => buildScaffold(byId("django-uv"), {project: "Config"}, {}), /TEMPLATE_INVALID/);
});

test("django-uv: Celery, Docker and pylint with bandit by their flags", () => {
  const {files} = buildScaffold(byId("django-uv"), {name: "shop", celery: true, docker: true, strictLint: true}, {});
  const pyproject = file(files, "pyproject.toml")!;
  assert.match(pyproject, /^ {4}"celery\[redis\]==5\.7\.0",$/m);
  assert.match(pyproject, /^ {4}"gunicorn==27\.0\.1",$/m);
  assert.match(pyproject, /^ {4}"celery-types==0\.26\.0",$/m);
  assert.match(pyproject, /^ {4}"pylint==4\.1\.4",\n {4}"pylint-django==2\.8\.0",$/m);
  assert.match(pyproject, /^ {4}"bandit==1\.9\.4",$/m);
  assert.match(file(files, "config/celery.py")!, /^app\.config_from_object\("django\.conf:settings", namespace="CELERY"\)$/m);
  assert.match(file(files, "config/__init__.py")!, /^from \.celery import app as celery_app$/m);
  assert.ok(file(files, "core/tasks.py") && file(files, "tests/test_tasks.py"));
  assert.match(file(files, "compose.yaml")!, /^ {2}worker:$/m);
  assert.match(file(files, "Dockerfile")!, /^USER 10001:10001$/m);
  assert.match(file(files, "Makefile")!, /^\t\$\(RUN\) pylint config core tests$/m);
  assert.match(pyproject, /^\[tool\.pylint\.main\]\nload-plugins = \["pylint_django"\]\ndjango-settings-module = "config\.test_settings"$/m);
  assert.match(file(files, "compose.yaml")!, /^ {4}image: redis:8\.12-alpine$/m);
});

test("django-uv on Poetry: the same project with Poetry's package-mode, its commands in the Makefile, and Poetry's CI", () => {
  const scaffold = byId("django-uv");
  const {files} = buildScaffold(scaffold, {name: "legacy-shop", tool: "poetry"}, {});
  const pyproject = file(files, "pyproject.toml")!;
  assert.match(pyproject, /^\[tool\.poetry\]\npackage-mode = false$/m);
  assert.match(pyproject, /^requires-python = ">=3\.13,<4"$/m);
  assert.doesNotMatch(pyproject, /\[tool\.uv\]/);
  assert.match(file(files, "Makefile")!, /^RUN := poetry run$/m);
  assert.match(file(files, "Makefile")!, /^bootstrap:\n\tpoetry install$/m);
  assert.doesNotMatch(file(files, ".pre-commit-config.yaml")!, /uv-pre-commit/);
});

test("an empty description leaves no empty paragraph in the prose files; a given one stands as its own paragraph", () => {
  for (const scaffold of builtinScaffolds) {
    const empty = buildScaffold(scaffold, {name: "tool", description: ""}, {}).files;
    for (const item of empty.filter(entry => entry.path.endsWith(".md")))
      assert.doesNotMatch(item.text, /\n\n\n/, scaffold.id + " " + item.path);
    const given = buildScaffold(scaffold, {name: "tool", description: "Keeps notes."}, {}).files;
    assert.match(file(given, "README.md")!, /^# [^\n]+\n\nKeeps notes\.\n\n## /, scaffold.id);
  }
  assert.match(file(buildScaffold(byId("django-uv"), {name: "shop", description: ""}, {}).files, "README.md")!, /^# shop\n\n## Development\n/);
  assert.match(file(buildScaffold(byId("django-uv"), {name: "shop", description: ""}, {}).files, "README.ru.md")!, /^# shop\n\n## Разработка\n/);
});
