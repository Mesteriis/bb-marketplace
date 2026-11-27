import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScaffold, scaffoldIssues, type Scaffold } from "../src/core/scaffolds/model.ts";

const tiny: Scaffold = {
  id: "tiny", title: "Tiny", description: "A tiny project.",
  params: [{name: "docker", label: "Docker", kind: "flag", default: false}, {name: "flavor", label: "Flavor", kind: "choice", default: "plain", choices: ["plain", "web"]}],
  files: [
    {path: "README.md", body: "# {{name}}\n\n{{description}}\n"},
    {path: "pyproject.toml", body: "[project]\nname = {{name|json}}\ndescription = {{description|json}}\n"},
    {path: "Dockerfile", body: "FROM scratch\n", when: "docker"},
    {path: "src/{{name}}/web.py", body: "app = 1\n", when: "flavor=web"},
    {path: "src/{{name}}/cli.py", body: "main = 1\n", when: "flavor!=web"},
    {path: "scripts/run.sh", body: "#!/bin/sh\nexec true\n", executable: true},
    {path: ".gitignore", body: "own\n"},
  ],
  ignore: ["/dist/"], editorconfig: "[*.py]\nindent_size = 4\n",
};
const paths = (scaffold: Scaffold, given = {}) => buildScaffold(scaffold, given, {}).files.map(file => file.path);

test("the common files come with every scaffold; a scaffold's own file of the same path replaces the common one", () => {
  const built = buildScaffold(tiny, {name: "notes", description: "Notes \"app\""}, {year: "2026"});
  assert.deepEqual(built.files.map(file => file.path), [
    ".editorconfig", ".gitattributes", ".gitignore", "AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "LICENSE", "README.md", "README.ru.md",
    "SECURITY.md", "THIRD_PARTY_NOTICES.md", "pyproject.toml", "scripts/run.sh", "src/notes/cli.py",
  ]);
  const file = (path: string) => built.files.find(item => item.path === path)!;
  assert.equal(file(".gitignore").text, "own\n");
  assert.equal(file("pyproject.toml").text, "[project]\nname = \"notes\"\ndescription = \"Notes \\\"app\\\"\"\n");
  assert.equal(file("README.md").text, "# notes\n\nNotes \"app\"\n");
  assert.equal(file("CLAUDE.md").text, "@AGENTS.md\n");
  assert.equal(file("scripts/run.sh").executable, true);
  assert.equal(file("README.md").executable, false);
  assert.match(file("LICENSE").text, /^MIT License\n\nCopyright \(c\) 2026 notes contributors\n/);
});

test("files follow their flag or choice, and the optional common files follow theirs", () => {
  assert.ok(paths(tiny, {docker: true}).includes("Dockerfile"));
  assert.ok(paths(tiny, {flavor: "web"}).includes("src/my-project/web.py") && !paths(tiny, {flavor: "web"}).includes("src/my-project/cli.py"));
  const all = paths(tiny, {contributing: true, codeOfConduct: true, license: "Apache-2.0"});
  assert.ok(all.includes("CONTRIBUTING.md") && all.includes("CODE_OF_CONDUCT.md") && all.includes("LICENSE"));
  assert.ok(!paths(tiny, {license: "none"}).includes("LICENSE"));
});

test("the common .gitignore closes .env files but .env.example, and .zed; a scaffold adds its own lines and editor sections", () => {
  const plain: Scaffold = {...tiny, files: tiny.files.filter(file => file.path !== ".gitignore")};
  const built = buildScaffold(plain, {}, {});
  const ignore = built.files.find(file => file.path === ".gitignore")!.text;
  assert.match(ignore, /^\.env\n\.env\.\*\n!\.env\.example\n/m);
  assert.match(ignore, /^\.zed\/$/m);
  assert.match(ignore, /^\/dist\/$/m);
  assert.match(built.files.find(file => file.path === ".editorconfig")!.text, /^root = true\n[\s\S]*\[\*\.py\]\nindent_size = 4\n$/);
});

test("free text goes as it is into Markdown only: in a TOML, JSON or YAML file it must be quoted with |json", () => {
  const raw: Scaffold = {...tiny, files: [{path: "pyproject.toml", body: "description = \"{{description}}\"\n"}]};
  assert.throws(() => buildScaffold(raw, {}, {}), /TEMPLATE_INVALID/);
});

test("a file may not leave the project, write into .git, or be a .env file other than .env.example", () => {
  for (const path of ["../x", "/etc/x", "a/../b", ".git/config", ".env", "config/.env.local", "a//b", ""])
    assert.throws(() => buildScaffold({...tiny, files: [{path, body: "x\n"}]}, {}, {}), /TEMPLATE_INVALID/, path);
  assert.ok(paths({...tiny, files: [{path: ".env.example", body: "TOKEN=\n"}]}).includes(".env.example"));
  assert.throws(() => buildScaffold({...tiny, files: [{path: "a.txt", body: "1\n"}, {path: "a.txt", body: "2\n"}]}, {}, {}), /TEMPLATE_INVALID/);
});

test("the project name is a folder and package name, and the common parameters cannot be redefined", () => {
  for (const name of ["My App", "-x", "a/b", ".hidden"]) assert.throws(() => buildScaffold(tiny, {name}, {}), /TEMPLATE_INVALID/, name);
  assert.deepEqual(scaffoldIssues({...tiny, params: [{name: "license", label: "L", kind: "text", default: "x"}]}),
    ["The scaffold redefines the common parameter license."]);
});

test("a scaffold is checked as a whole: it renders with every choice and flag, and has no secret-like text", () => {
  assert.deepEqual(scaffoldIssues(tiny), []);
  assert.deepEqual(scaffoldIssues({...tiny, files: [{path: "x.md", body: "{{#docker}}\n{{nope}}\n{{/docker}}\n"}]}), ["The scaffold does not render: unknown name nope."]);
  assert.deepEqual(scaffoldIssues({...tiny, files: [{path: "deploy.md", body: "ssh admin@10.1.2.3\n"}]}), ["deploy.md has an IP address."]);
});
