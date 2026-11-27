import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ciStack, ciTemplateFolder } from "../src/adapters/bb/ci-template-host.ts";

let base: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args], {cwd, encoding: "utf8"});
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "ci-template-host-"))); });
afterEach(() => rmSync(base, {recursive: true, force: true}));

test("the stack input is the committed root entries, the CI files and the root manifests of HEAD, not the working copy", async () => {
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".github/workflows"), {recursive: true});
  mkdirSync(join(repo, "web"), {recursive: true});
  git(base, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "package.json"), "{\"scripts\":{\"test\":\"x\"}}\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(repo, "web/package.json"), "{}\n");
  writeFileSync(join(repo, ".github/workflows/old.yml"), "on: push\n");
  writeFileSync(join(repo, ".gitlab-ci.yml"), "ci:\n  script: [true]\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "first");
  // Uncommitted and untracked files are not what the new branch is built from.
  writeFileSync(join(repo, "package.json"), "{\"scripts\":{}}\n");
  writeFileSync(join(repo, "go.mod"), "module x\n");
  const found = await ciStack(repo);
  assert.equal(found.head, git(repo, "rev-parse", "HEAD").trim());
  assert.deepEqual(found.paths, [".github", ".github/workflows/old.yml", ".gitlab-ci.yml", "package.json", "pnpm-lock.yaml", "web"]);
  assert.deepEqual(found.manifests, {"package.json": "{\"scripts\":{\"test\":\"x\"}}\n"});
});

test("a repository without commits has no stack input", async () => {
  const repo = join(base, "empty");
  git(base, "init", "-q", "-b", "main", repo);
  assert.deepEqual(await ciStack(repo), {head: null, paths: [], manifests: {}});
});

test("a manifest over 64 KB is left out", async () => {
  const repo = join(base, "big");
  git(base, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "package.json"), "{\"x\":\"" + "a".repeat(70 * 1024) + "\"}");
  git(repo, "add", "."); git(repo, "commit", "-qm", "first");
  assert.deepEqual((await ciStack(repo)).manifests, {});
});

test("the templates folder gives its JSON files, sorted, without links, folders or large files; a missing folder gives none", async () => {
  const folder = join(base, "templates");
  mkdirSync(join(folder, "sub.json"), {recursive: true});
  writeFileSync(join(folder, "b.json"), "{\"id\":\"b\"}");
  writeFileSync(join(folder, "a.json"), "{\"id\":\"a\"}");
  writeFileSync(join(folder, "notes.txt"), "x");
  writeFileSync(join(folder, "big.json"), "x".repeat(65 * 1024));
  writeFileSync(join(base, "outside.json"), "{}");
  symlinkSync(join(base, "outside.json"), join(folder, "link.json"));
  assert.deepEqual(await ciTemplateFolder(folder), {files: [{name: "a.json", text: "{\"id\":\"a\"}"}, {name: "b.json", text: "{\"id\":\"b\"}"}],
    skipped: ["big.json", "link.json", "sub.json"]});
  assert.deepEqual(await ciTemplateFolder(join(base, "none")), {files: [], skipped: []});
  await assert.rejects(ciTemplateFolder("relative/path"), {message: "INVALID_PATH"});
});
