import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { publishFirst, scaffoldCreate } from "../src/adapters/bb/scaffold-host.ts";

let base: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {cwd, encoding: "utf8"});
const author = {name: "Stand Author", email: "author@example.invalid"};
const files = [
  {path: "README.md", text: "# demo\n", executable: false},
  {path: "src/demo/__init__.py", text: "", executable: false},
  {path: "scripts/run.sh", text: "#!/bin/sh\n", executable: true},
];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "scaffold-host-")));
  mkdirSync(join(base, "projects/Personal"), {recursive: true});
});
afterEach(() => rmSync(base, {recursive: true, force: true}));

test("a project is made in a category of the projects folder: its files, a main branch and one commit by the author", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "demo", files, author, "Initial commit from the demo scaffold");
  const root = join(base, "projects/Personal/demo");
  assert.equal(made.root, root);
  assert.match(made.identity, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# demo\n");
  assert.equal(statSync(join(root, "scripts/run.sh")).mode & 0o777, 0o755);
  assert.equal(statSync(join(root, "README.md")).mode & 0o777, 0o644);
  assert.equal(git(root, "branch", "--show-current").trim(), "main");
  assert.equal(git(root, "log", "--format=%an <%ae>|%s").trim(), "Stand Author <author@example.invalid>|Initial commit from the demo scaffold");
  assert.equal(git(root, "ls-files").trim().split("\n").sort().join(","), "README.md,scripts/run.sh,src/demo/__init__.py");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("the projects folder itself is a category too", async () => {
  assert.equal((await scaffoldCreate(join(base, "projects"), "", "top", files, author, "Initial")).root, join(base, "projects/top"));
});

test("only a new folder inside the projects folder, under an existing category", async () => {
  mkdirSync(join(base, "projects/Personal/taken"));
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal", "taken", files, author, "x"), {message: "DESTINATION_EXISTS"});
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Missing", "demo", files, author, "x"), {message: "INVALID_DESTINATION"});
  await assert.rejects(scaffoldCreate(join(base, "projects"), "..", "demo", files, author, "x"), {message: "INVALID_DESTINATION"});
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal", "../escape", files, author, "x"), {message: "INVALID_DESTINATION"});
  // A category that is a link to somewhere else is not inside the projects folder.
  mkdirSync(join(base, "elsewhere"));
  symlinkSync(join(base, "elsewhere"), join(base, "projects/Linked"));
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Linked", "demo", files, author, "x"), {message: "INVALID_DESTINATION"});
  assert.ok(!existsSync(join(base, "elsewhere/demo")));
});

test("a file path that would leave the project fails, and the half-made folder is removed", async () => {
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal", "bad", [...files, {path: "../out.txt", text: "x", executable: false}], author, "x"),
    {message: "INVALID_PATH"});
  assert.ok(!existsSync(join(base, "projects/Personal/bad")));
  assert.ok(!existsSync(join(base, "projects/Personal/out.txt")));
});

test("the host too refuses a .git path of any case at any depth, and a project inside another project's working tree", async () => {
  for (const path of [".GIT/config", "sub/.git/config", "a/.Git/hooks/x"])
    await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal", "cased", [{path, text: "x", executable: false}], author, "x"), {message: "INVALID_PATH"}, path);
  assert.ok(!existsSync(join(base, "projects/Personal/cased")));
  mkdirSync(join(base, "projects/Personal/repo/inner"), {recursive: true});
  git(join(base, "projects/Personal/repo"), "init", "-q");
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal/repo", "nested", files, author, "x"), {message: "INVALID_DESTINATION"});
  await assert.rejects(scaffoldCreate(join(base, "projects"), "Personal/repo/inner", "nested", files, author, "x"), {message: "INVALID_DESTINATION"});
  assert.ok(!existsSync(join(base, "projects/Personal/repo/nested")));
});

test("the first push adds origin as the plain clone address, refuses another origin, and never writes a credential", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "pushed", files, author, "Initial");
  const root = made.root;
  await assert.rejects(publishFirst(root, made.identity, "https://git.example.org/octo/pushed.git", "octo", async () => { throw new Error("PUSH_FAILED"); }),
    {message: "PUSH_FAILED"});
  assert.equal(git(root, "remote", "get-url", "origin").trim(), "https://git.example.org/octo/pushed.git");
  // Again with the same origin is fine; the push is what decides.
  const head = git(root, "rev-parse", "HEAD").trim();
  const pushed: unknown[] = [];
  await publishFirst(root, made.identity, "https://git.example.org/octo/pushed.git", "octo", async (...args) => { pushed.push(args); });
  assert.deepEqual(pushed, [[root, "https://git.example.org/octo/pushed.git", "octo", {kind: "push", expected: head, branch: "main"}, undefined]]);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");
  assert.equal(git(root, "rev-parse", "origin/main").trim(), head);
  assert.doesNotMatch(readFileSync(join(root, ".git/config"), "utf8"), /@|token|password/i);
  await assert.rejects(publishFirst(root, made.identity, "https://git.example.org/other/x.git", "octo", async () => {}), {message: "REMOTE_MISMATCH"});
  await assert.rejects(publishFirst(root, made.identity, "https://octo:secret@git.example.org/octo/pushed.git", "octo", async () => {}), {message: "INVALID_REMOTE"});
});
