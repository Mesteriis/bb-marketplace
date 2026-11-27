import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

let root: string;
const file = "literal[1].txt";
const original = ["first", ...Array(12).fill("middle"), "last"].join("\n") + "\n";
const changed = original.replace("first", "FIRST").replace("last", "LAST");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const service = () => import("../src/adapters/bb/local-git.ts");
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-workspace-test-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, file), original);
  git("add", "--", file);
  git("commit", "-qm", "Initial");
  writeFileSync(join(root, file), changed);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("stages a single hunk and commits only the staged content", async () => {
  const { localGit } = await service();
  const initial = await localGit(root, { kind: "status" });
  assert.deepEqual(initial.files, [{ path: file, index: ".", worktree: "M" }]);
  const diff = await localGit(root, { kind: "diff", path: file, staged: false });
  assert.equal(diff.hunks?.length, 2);
  await localGit(root, { kind: "hunk", path: file, staged: false, token: diff.hunks![0].token });
  assert.equal(git("show", ":" + file), original.replace("first", "FIRST"));
  const status = await localGit(root, { kind: "status" });
  await localGit(root, { kind: "commit", message: "First hunk", expected: status.snapshot! });
  assert.equal(git("show", "HEAD:" + file), original.replace("first", "FIRST"));
  assert.match(git("diff"), /^\+LAST$/m);
});

test("rejects a hunk after worktree content changes", async () => {
  const { localGit } = await service();
  const diff = await localGit(root, { kind: "diff", path: file, staged: false });
  writeFileSync(join(root, file), changed.replace("FIRST", "Extra"));
  await assert.rejects(localGit(root, { kind: "hunk", path: file, staged: false, token: diff.hunks![0].token }), /STALE_HUNK/);
  assert.equal(git("show", ":" + file), original);
});

test("does not commit an index changed by external Git after preview", async () => {
  const { localGit } = await service();
  const status = await localGit(root, { kind: "status" });
  git("add", "--", file);
  await assert.rejects(localGit(root, { kind: "commit", message: "Unexpected", expected: status.snapshot! }), /STALE_INDEX/);
  assert.equal(git("log", "-1", "--format=%s").trim(), "Initial");
});

test("rejects nested paths that are not worktree roots", async () => {
  const { localGit } = await service();
  const nested = join(root, "nested");
  mkdirSync(nested);
  await assert.rejects(localGit(nested, { kind: "status" }), /INVALID_WORKTREE/);
});

test("clones and pushes a linked worktree branch to an explicit local bare remote", async () => {
  const { cloneLocal, localGit } = await service();
  const parent = mkdtempSync(join(tmpdir(),"git-dashboard-network-"));
  try {
    const bare = join(parent,"origin.git");
    const clone = join(parent,"clone");
    const linked = join(parent,"linked");
    git("clone","--bare","--",root,bare);
    const canonical = await cloneLocal(bare,clone);
    const branch = await localGit(canonical,{kind:"status"});
    const result = await localGit(canonical,{kind:"worktree",branch:"topic",base:branch.head!,destination:linked});
    const worktree = result.worktrees?.find(worktree => worktree.branch === "topic");
    assert.ok(worktree);
    const occupied = await localGit(canonical,{kind:"switch",branch:"topic"});
    assert.equal(occupied.text,"BRANCH_OCCUPIED");
    assert.equal(occupied.worktrees?.[0].path,worktree.path);
    const origin = await localGit(worktree.path,{kind:"localOrigin"});
    assert.equal(origin.text,realpathSync(bare));
    await assert.rejects(localGit(worktree.path,{kind:"push",expected:branch.head!,branch:"main",destination:origin.text!}),/STALE_HEAD/);
    await localGit(worktree.path,{kind:"push",expected:branch.head!,branch:"topic",destination:origin.text!});
    assert.equal(git("--git-dir",bare,"rev-parse","refs/heads/topic").trim(),branch.head);
    await localGit(canonical,{kind:"fetch"});
    assert.equal(git("-C",clone,"rev-parse","refs/remotes/origin/topic").trim(),branch.head);
  } finally { rmSync(parent,{recursive:true,force:true}); }
});

test("does not let a tool stage multiple files using a directory as a file", async () => {
  const {localGit} = await service();
  mkdirSync(join(root,"directory"));
  writeFileSync(join(root,"directory","a"),"a");
  writeFileSync(join(root,"directory","b"),"b");
  await assert.rejects(localGit(root,{kind:"stage",path:"directory",staged:false}),/INVALID_PATH/);
  assert.equal(git("diff","--cached","--name-only"),"");
});

test("rejects registration for a checkout replaced at the same canonical path", async () => {
  const {worktreeIdentity,assertWorktree} = await service();
  const registration = await worktreeIdentity(root);
  const newPath = root + "-previous";
  const {renameSync} = await import("node:fs");
  renameSync(root,newPath);
  try {
    mkdirSync(root);
    git("init","-q","-b","main");
    await assert.rejects(assertWorktree(root,registration.identity),/WORKTREE_REPLACED/);
  } finally {rmSync(newPath,{recursive:true,force:true});}
});

test("catalog discovery from a linked copy includes the main and detached working trees", async () => {
  const {localGit} = await service();
  const parent = realpathSync(mkdtempSync(join(tmpdir(),"git-catalog-")));
  try {
    const linked = join(parent,"linked copy");
    git("worktree","add","--detach",linked,"HEAD");
    const result = await localGit(linked,{kind:"worktrees"});
    assert.deepEqual(result.worktrees?.map(({path,branch}) => [path,branch]), [[root,"main"],[linked,undefined]]);
  } finally {
    rmSync(parent,{recursive:true,force:true});
  }
});

test("BB repository metadata permits catalog reads while other Git commands keep strict validation", async () => {
  const {worktreeIdentity, assertWorktree, localGit} = await service();
  git("config","extensions.worktreeConfig","true");
  git("config","credential.helper","osxkeychain");
  git("config","branch.main.bbowned","true");
  git("config","remote.origin.gh-resolved","base");
  const copy = await worktreeIdentity(root,undefined,true);
  await assertWorktree(root,copy.identity,undefined,true);
  assert.equal((await localGit(root,{kind:"worktrees"})).worktrees?.[0].branch,"main");
  await assert.rejects(localGit(root,{kind:"status"}),/UNSUPPORTED_REPOSITORY_CONFIG/);
  await assert.rejects(localGit(root,{kind:"stage",path:file,staged:true}),/UNSUPPORTED_REPOSITORY_CONFIG/);
  git("config","--worktree","include.path","absent");
  await assert.rejects(worktreeIdentity(root,undefined,true),/UNSUPPORTED_REPOSITORY_CONFIG/);
});

test("reads the origin URL as configured and reports a missing origin", async () => {
  const { originUrl } = await service();
  await assert.rejects(originUrl(root), {message: "NO_ORIGIN"});
  git("remote", "add", "origin", "git@github-office:Mesteriis/makosh-git-sandbox.git");
  assert.equal(await originUrl(root), "git@github-office:Mesteriis/makosh-git-sandbox.git");
});
