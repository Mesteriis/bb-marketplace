import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readScaffoldTree } from "../src/adapters/bb/scaffold-tree.ts";
import { buildScaffold } from "../src/core/scaffolds/model.ts";
import { loadRepository } from "../src/core/scaffolds/source.ts";

const fixture = new URL("./fixtures/scaffold-repo", import.meta.url).pathname;
let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "scaffold-tree-"))); });
afterEach(() => rmSync(base, {recursive: true, force: true}));

test("a templates folder is read as text, binary files as base64, with the executable bit; .git is left out", async () => {
  const tree = await readScaffoldTree(fixture);
  const byPath = new Map(tree.files.map(file => [file.path, file]));
  assert.equal(byPath.get("templates/demo/files/README.md")!.text, "# {{name}}\n\n{{description}}\n");
  assert.equal(byPath.get("templates/demo/files/run.sh")!.executable, true);
  assert.deepEqual(byPath.get("templates/demo/files/src/service/icon.png"), {path: "templates/demo/files/src/service/icon.png",
    text: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString("base64"), base64: true, executable: false});
  assert.equal(tree.files.length, 16);
});

test("a link, a file over 256 KB or too many files refuse the whole folder with the reason", async () => {
  mkdirSync(join(base, "templates/a/files"), {recursive: true});
  writeFileSync(join(base, "outside.txt"), "x");
  symlinkSync(join(base, "outside.txt"), join(base, "templates/a/files/link.txt"));
  await assert.rejects(readScaffoldTree(base), {message: "SCAFFOLDS_INVALID", detail: "templates/a/files/link.txt is a link"});
  rmSync(join(base, "templates/a/files/link.txt"));
  writeFileSync(join(base, "templates/a/files/big.txt"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(readScaffoldTree(base), {message: "SCAFFOLDS_INVALID", detail: "templates/a/files/big.txt is over 256 KB"});
  await assert.rejects(readScaffoldTree("relative/path"), {message: "INVALID_PATH"});
});

test("the loader gives each template as a scaffold: labels in both languages, conditions by glob, renames, verbatim, bytes", async () => {
  const {common, offered, rejected} = loadRepository((await readScaffoldTree(fixture)).files, "folder");
  assert.deepEqual(offered.map(item => item.key), ["folder:demo"]);
  assert.deepEqual(rejected, [{source: "folder", name: "broken", issues: ["templates/broken/template.json does not match the template format: unknown field surprise."]}]);
  const demo = offered[0]!.scaffold;
  assert.deepEqual([demo.title, demo.i18n?.ru?.title, demo.params[0]!.label, demo.i18n?.ru?.labels?.variant], ["Demo service", "Демо-сервис", "Kind", "Вид"]);
  const docker = buildScaffold(demo, {name: "shop", variant: "web", docker: true, license: "MIT", year: "2026", author: "Ann"}, {}, common!);
  const out = new Map(docker.files.map(file => [file.path, file]));
  assert.equal(out.get("LICENSE")!.text, "MIT License\n\nCopyright (c) 2026 Ann\n");
  assert.ok(!out.has("LICENSE.MIT") && !out.has("LICENSE.Apache-2.0") && !out.has("CONTRIBUTING.md"));
  assert.equal(out.get("src/service/shop.py")!.text, "print(\"shop\")\n");
  assert.ok(out.has("src/service/web.py") && out.has("docker/Dockerfile"));
  assert.equal(out.get("src/service/App.vue")!.text, "<template><p>{{ msg }}</p></template>\n");
  assert.equal(out.get("src/service/icon.png")!.base64, true);
  assert.equal(out.get("run.sh")!.executable, true);
  assert.equal(out.get(".gitignore")!.text, ".env\n\n.venv/\n");
  assert.equal(out.get(".editorconfig")!.text, "root = true\n\n[*.py]\nindent_size = 4\n");
  const plain = new Set(buildScaffold(demo, {name: "shop", license: "Apache-2.0", contributing: true}, {}, common!).files.map(file => file.path));
  assert.ok(!plain.has("docker/Dockerfile") && !plain.has("src/service/web.py") && plain.has("CONTRIBUTING.md"));
});

test("a newer format, a missing manifest and an id that is not its folder are refused, the others still offered", () => {
  const files = [
    {path: "templates/next/template.json", text: JSON.stringify({format: 2, id: "next"}), executable: false},
    {path: "templates/bare/files/a.txt", text: "x\n", executable: false},
    {path: "templates/moved/template.json", text: JSON.stringify({format: 1, id: "other", title: {en: "M"}, description: {en: ""}, params: []}), executable: false},
    {path: "templates/ok/template.json", text: JSON.stringify({format: 1, id: "ok", title: {en: "Ok"}, description: {en: ""}, params: []}), executable: false},
    {path: "templates/ok/files/README.md", text: "# {{name}}\n", executable: false},
  ];
  const {offered, rejected, common} = loadRepository(files, "folder");
  assert.equal(common, null);
  assert.deepEqual(offered.map(item => item.key), ["folder:ok"]);
  assert.deepEqual(rejected.map(item => [item.name, item.issues]), [
    ["bare", ["templates/bare/template.json is missing."]],
    ["moved", ["templates/moved/template.json: the id other is not its folder's name."]],
    ["next", ["templates/next/template.json is of format 2: it needs a newer Makosh Git."]],
  ]);
});

test("the local templates folder setting offers its templates after the built-in ones, and the preview renders with its common layer", async () => {
  const {scaffoldHandlers} = await import("../src/adapters/bb/scaffold-rpc.ts");
  const asked: unknown[] = [];
  const bb = {
    settings: {define: () => ({get: async () => ({scaffolds: "", scaffoldsFolder: "/somewhere/templates"})})},
    hosts: {experimental_client: () => ({call: async (name: string, input: unknown) => {
      asked.push([name, input]);
      if (name === "scaffoldTree") return {ok: true, ...await readScaffoldTree(fixture)};
      if (name === "credentialHelper") return {ok: true, keychain: true};
      throw new Error("not expected: " + name);
    }})},
    onDispose: () => {}, realtime: {publish: () => {}},
  } as never;
  const handlers = scaffoldHandlers(bb, {rules: async () => ({root: "/home/owner/projects"}), saveCopy: async () => ({}) as never,
    accounts: async () => [], api: async () => { throw new Error("no"); }, link: async () => {}, record: async () => {}});
  const client = {experimental_caller: {kind: "client"}} as never;
  const view = await handlers.scaffoldsView({hostId: "host-1"}, client) as {ok: true; offered: {key: string}[]; rejected: {name: string}[]};
  assert.deepEqual(view.offered.map(item => item.key).filter(key => key.startsWith("folder:")), ["folder:demo"]);
  assert.ok(view.offered[0]!.key.startsWith("builtin:"));
  assert.deepEqual(view.rejected.map(item => item.name), ["broken"]);
  assert.deepEqual(asked[0], ["scaffoldTree", {folder: "/somewhere/templates"}]);
  const preview = await handlers.scaffoldPrepare({hostId: "host-1", key: "folder:demo", values: {name: "shop", docker: true}, category: "", ciForge: null,
    author: {name: "Ann", email: "ann@example.invalid"}, repository: null}, client) as {ok: true; preview: {files: {path: string}[]}};
  const paths = preview.preview.files.map(file => file.path);
  assert.ok(paths.includes("LICENSE") && paths.includes("docker/Dockerfile") && paths.includes("src/service/shop.py") && !paths.includes("LICENSE.MIT"), paths.join(","));
});
