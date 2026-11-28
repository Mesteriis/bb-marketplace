import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScaffold, scaffoldIssues, type CommonLayer, type Scaffold } from "../src/core/scaffolds/model.ts";

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
/** A templates repository's common layer, as its common/ folder gives it. */
const common: CommonLayer = {files: [
  {path: ".gitignore", body: ".env\n.env.*\n!.env.example\n"},
  {path: ".editorconfig", body: "root = true\n"},
  {path: "AGENTS.md", body: "# {{name}}\n"},
  {path: "LICENSE", body: "MIT License\n\nCopyright (c) {{year}} {{holder}}\n", when: "license=MIT"},
  {path: "CONTRIBUTING.md", body: "Contributions welcome.\n", when: "contributing"},
]};
const paths = (scaffold: Scaffold, given = {}) => buildScaffold(scaffold, given, {}, common).files.map(file => file.path);

test("the common files come with every scaffold; a scaffold's own file of the same path replaces the common one", () => {
  const built = buildScaffold(tiny, {name: "notes", description: "Notes \"app\""}, {year: "2026"}, common);
  assert.deepEqual(built.files.map(file => file.path),
    [".editorconfig", ".gitignore", "AGENTS.md", "LICENSE", "README.md", "pyproject.toml", "scripts/run.sh", "src/notes/cli.py"]);
  const file = (path: string) => built.files.find(item => item.path === path)!;
  assert.equal(file(".gitignore").text, "own\n");
  assert.equal(file("pyproject.toml").text, "[project]\nname = \"notes\"\ndescription = \"Notes \\\"app\\\"\"\n");
  assert.equal(file("README.md").text, "# notes\n\nNotes \"app\"\n");
  assert.equal(file("AGENTS.md").text, "# notes\n");
  assert.equal(file("scripts/run.sh").executable, true);
  assert.equal(file("README.md").executable, false);
  assert.equal(file("LICENSE").text, "MIT License\n\nCopyright (c) 2026 notes contributors\n");
});

test("without a common layer a scaffold writes its own files only: the plugin holds none of its own", () => {
  assert.deepEqual(buildScaffold(tiny, {name: "notes"}, {}).files.map(file => file.path), [".gitignore", "README.md", "pyproject.toml", "scripts/run.sh", "src/notes/cli.py"]);
});

test("files follow their flag or choice, and the optional common files follow theirs", () => {
  assert.ok(paths(tiny, {docker: true}).includes("Dockerfile"));
  assert.ok(paths(tiny, {flavor: "web"}).includes("src/my-project/web.py") && !paths(tiny, {flavor: "web"}).includes("src/my-project/cli.py"));
  assert.ok(paths(tiny, {contributing: true}).includes("CONTRIBUTING.md"));
  assert.ok(!paths(tiny, {license: "none"}).includes("LICENSE"));
});

test("a scaffold adds its own lines to the common .gitignore and its sections to .editorconfig", () => {
  const plain: Scaffold = {...tiny, files: tiny.files.filter(file => file.path !== ".gitignore")};
  const built = buildScaffold(plain, {}, {}, common);
  assert.equal(built.files.find(file => file.path === ".gitignore")!.text, ".env\n.env.*\n!.env.example\n\n/dist/\n");
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
  for (const name of ["My App", "-x", "a/b", ".hidden"])
    assert.throws(() => buildScaffold(tiny, {name}, {}), (error: Error & {detail?: string}) => error.message === "TEMPLATE_INVALID"
      && /the project name must be a folder name/.test(error.detail ?? ""), name);
  assert.deepEqual(scaffoldIssues({...tiny, params: [{name: "license", label: "L", kind: "text", default: "x"}]}),
    ["The scaffold redefines the common parameter license."]);
});

test("a scaffold is checked as a whole: it renders with every choice and flag, and has no secret-like text", () => {
  assert.deepEqual(scaffoldIssues(tiny), []);
  assert.deepEqual(scaffoldIssues({...tiny, files: [{path: "x.md", body: "{{#docker}}\n{{nope}}\n{{/docker}}\n"}]}), ["The scaffold does not render: x.md: unknown name nope."]);
  assert.deepEqual(scaffoldIssues({...tiny, files: [{path: "deploy.md", body: "ssh admin@10.1.2.3\n"}]}), ["deploy.md has an IP address."]);
});

test("no file goes into a .git folder of any case, at any depth, and paths that differ only in case are one path", () => {
  for (const path of [".GIT/config", ".Git/hooks/pre-commit", "sub/.git/config", "a/.GIT/x"])
    assert.throws(() => buildScaffold({...tiny, files: [{path, body: "x\n"}]}, {}, {}), /TEMPLATE_INVALID/, path);
  assert.throws(() => buildScaffold({...tiny, files: [{path: "docs/Guide.md", body: "a\n"}, {path: "docs/guide.md", body: "b\n"}]}, {}, {}), /TEMPLATE_INVALID/);
});

test("free text goes as it is into Markdown, LICENSE and NOTICE only; never into a shell, Make or Docker file, even quoted", () => {
  const withText = (path: string, body: string) => ({...tiny, files: [{path, body}]});
  assert.throws(() => buildScaffold(withText("requirements.txt", "{{description}}\n"), {}, {}), /TEMPLATE_INVALID/);
  assert.throws(() => buildScaffold(withText("CMakeLists.txt", "project({{description}})\n"), {}, {}), /TEMPLATE_INVALID/);
  for (const path of ["Makefile", "scripts/run.sh", "Dockerfile", "docker/api.Dockerfile", "rules.mk", ".env.example"])
    assert.throws(() => buildScaffold(withText(path, "X = {{description|json}}\n"), {description: "costs $(rm -rf /)"}, {}), /TEMPLATE_INVALID/, path);
  // Words (names, versions) are safe there.
  assert.ok(buildScaffold(withText("Makefile", "NAME = {{name}}\n"), {}, {}).files.some(file => file.path === "Makefile"));
});
