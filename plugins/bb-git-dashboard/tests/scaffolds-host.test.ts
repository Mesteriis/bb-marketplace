import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { publishFirst, saveCredential, scaffoldCreate } from "../src/adapters/bb/scaffold-host.ts";

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

/**
 * Puts a `git` first on PATH that records the arguments and environment of every `credential` call, swaps the macOS
 * helper for a file-backed stand-in, and runs the real Git — so Git itself parses the helper input with useHttpPath.
 * The stand-in records what it is asked to store and answers lookups from its file; `broken` makes it store nothing,
 * as a locked or missing Keychain would while `git credential approve` still exits 0.
 */
function recordingGit(): {calls: string; stored: string; broken: string; restore(): void} {
  const dir = join(base, "fake-bin");
  mkdirSync(dir);
  const [calls, stored, broken] = ["calls.log", "stored.log", "broken"].map(name => join(base, name)) as [string, string, string];
  const real = execFileSync("sh", ["-c", "command -v git"], {encoding: "utf8"}).trim();
  const node = process.execPath;
  writeFileSync(join(dir, "helper.mjs"), `#!${node}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const fields = Object.fromEntries(input.split("\\n").filter(Boolean).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const key = ["protocol", "host", "path", "username"].map(name => fields[name] ?? "").join("|");
const action = process.argv[2];
if (action === "store" && !existsSync(${JSON.stringify(broken)})) appendFileSync(${JSON.stringify(stored)}, JSON.stringify({key, input}) + "\\n");
if (action === "erase") appendFileSync(${JSON.stringify(stored)}, JSON.stringify({key, erase: true}) + "\\n");
if (action === "get" && existsSync(${JSON.stringify(stored)})) {
  let password = null;
  for (const line of readFileSync(${JSON.stringify(stored)}, "utf8").split("\\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.key === key) password = entry.erase ? null : /^password=(.*)$/m.exec(entry.input)[1];
  }
  if (password !== null) process.stdout.write("password=" + password + "\\n");
}
`);
  writeFileSync(join(dir, "git"), `#!/bin/sh
case " $* " in *" credential "*) { printf 'ARGV %s\\n' "$*"; env | sed 's/^/ENV /'; } >> '${calls}';; esac
for arg do shift; [ "$arg" = "credential.helper=osxkeychain" ] && arg="credential.helper=${join(dir, "helper.mjs")}"; set -- "$@" "$arg"; done
exec '${real}' "$@"
`);
  chmodSync(join(dir, "git"), 0o755);
  chmodSync(join(dir, "helper.mjs"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = dir + ":" + path;
  return {calls, stored, broken, restore: () => { process.env.PATH = path; }};
}
const storedInputs = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).input) : [];

test("the token goes to the Keychain helper on stdin only, for the exact repository address and the account's user, and is read back", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "kept", files, author, "Initial");
  const secret = "fixture-token-value-0123456789";
  const fake = recordingGit();
  try { await saveCredential(made.root, made.identity, "https://git.example.org:8443/team/sub/kept.git", "octo", secret, undefined, "darwin"); }
  finally { fake.restore(); }
  // Git handed the helper exactly these fields: the path is the repository's own (credential.useHttpPath).
  assert.deepEqual(storedInputs(fake.stored), ["protocol=https\nhost=git.example.org:8443\npath=team/sub/kept.git\nusername=octo\npassword=" + secret + "\n"]);
  // Neither the arguments nor the environment of any Git process carry it; the helper is the system one, keyed by path.
  const calls = readFileSync(fake.calls, "utf8");
  assert.doesNotMatch(calls, new RegExp(secret));
  const argv = calls.split("\n").filter(line => line.startsWith("ARGV "));
  assert.deepEqual(argv.map(line => line.split(" ").slice(-2).join(" ")), ["credential approve", "credential fill"]);
  for (const option of ["credential.helper= ", "credential.helper=osxkeychain ", "credential.useHttpPath=true ", "credential.username=octo "]) assert.ok(argv[0]!.includes(option), option);
  // origin is the plain address, set before the token, so the copy can be linked whatever happens next.
  assert.equal(git(made.root, "remote", "get-url", "origin").trim(), "https://git.example.org:8443/team/sub/kept.git");
  assert.doesNotMatch(readFileSync(join(made.root, ".git/config"), "utf8"), new RegExp(secret + "|password|credential"));
});

test("a helper that saves nothing is caught by reading the entry back; origin is set all the same", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "locked", files, author, "Initial");
  const fake = recordingGit();
  writeFileSync(fake.broken, "");
  try {
    await assert.rejects(saveCredential(made.root, made.identity, "https://git.example.org/octo/locked.git", "octo", "fixture-token-value", undefined, "darwin"),
      {message: "CREDENTIAL_NOT_SAVED"});
  } finally { fake.restore(); }
  assert.deepEqual(storedInputs(fake.stored), []);
  assert.equal(git(made.root, "remote", "get-url", "origin").trim(), "https://git.example.org/octo/locked.git");
});

test("the path is the one Git asks for at push: trailing slashes dropped, percent-escapes decoded", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "paths", files, author, "Initial");
  const fake = recordingGit();
  try { await saveCredential(made.root, made.identity, "https://git.example.org/octo/my%20repo.git/", "octo", "fixture-token-value", undefined, "darwin"); }
  finally { fake.restore(); }
  assert.match(storedInputs(fake.stored)[0] ?? "", /\npath=octo\/my repo\.git\n/);
});

test("a token or address that could change the helper's input is refused before Git runs; other systems have no helper", async () => {
  const made = await scaffoldCreate(join(base, "projects"), "Personal", "refused", files, author, "Initial");
  const fake = recordingGit();
  try {
    for (const [clone, user, secret, code] of [
      ["https://git.example.org/octo/r.git", "octo", "token\nhost=evil.example", "INVALID_INPUT"],
      ["https://git.example.org/octo/r.git", "octo", "", "INVALID_INPUT"],
      ["https://git.example.org/octo/r.git", "oc\nto", "fixture-token", "INVALID_REMOTE"],
      ["https://octo@git.example.org/octo/r.git", "octo", "fixture-token", "INVALID_REMOTE"],
      ["http://git.example.org/octo/r.git", "octo", "fixture-token", "INVALID_REMOTE"],
      ["https://git.example.org/octo/a%0Ahost=evil.example.git", "octo", "fixture-token", "INVALID_REMOTE"],
      ["https://git.example.org/octo/a%00b.git", "octo", "fixture-token", "INVALID_REMOTE"],
    ] as const) await assert.rejects(saveCredential(made.root, made.identity, clone, user, secret, undefined, "darwin"), {message: code}, clone + " " + JSON.stringify(user));
    await assert.rejects(saveCredential(made.root, made.identity, "https://git.example.org/octo/r.git", "octo", "fixture-token", undefined, "linux"),
      {message: "CREDENTIAL_HELPER_UNAVAILABLE"});
    await assert.rejects(saveCredential(made.root, "b".repeat(64), "https://git.example.org/octo/r.git", "octo", "fixture-token", undefined, "darwin"));
  } finally { fake.restore(); }
  assert.equal(existsSync(fake.calls), false);
});
