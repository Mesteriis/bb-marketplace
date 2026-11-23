import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { author, type GitAction, type GitResult } from "../../core/git.ts";
import { gitRunner, type GitRun } from "./git-process.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const gitError = (code: string): never => { throw new Error(code); };
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function within(root: string, target: string) {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

async function directory(path: string) {
  if (!isAbsolute(path)) gitError("INVALID_WORKTREE");
  const resolved = await realpath(path).catch(() => gitError("INVALID_WORKTREE"));
  if (!(await stat(resolved)).isDirectory()) gitError("INVALID_WORKTREE");
  return resolved;
}

async function filePath(root: string, path: string) {
  if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    gitError("INVALID_PATH");
  }
  const parts = path.split("/");
  parts.pop();
  while (parts.length) {
    const ancestor = await realpath(join(root, ...parts)).catch(error => missing(error) ? null : Promise.reject(error));
    if (ancestor !== null) {
      if (!within(root, ancestor) || ancestor !== join(root, ...parts)) gitError("INVALID_PATH");
      break;
    }
    parts.pop();
  }
  return path;
}

async function safeConfig(git: GitRun, catalog = false) {
  // Accept conventional clone/worktree config and reject executable overrides.
  const {text} = await git(["config", "--local", "--no-includes", "--null", "--name-only", "--list"])
    .catch(() => gitError("INVALID_WORKTREE"));
  const safe = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|safecrlf|eol|symlinks|abbrev|commentchar|quotepath|protecthfs|protectntfs)|extensions\.(?:objectformat|refstorage)|user\.(?:name|email)|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge)|init\.defaultbranch)$/i;
  // These keys are inert for rev-parse and worktree list. Never extend the
  // policy for status, transport or mutations with catalog-only exceptions.
  const metadata = /^(?:credential\.helper|extensions\.worktreeconfig|branch\..+\.bbowned|remote\..+\.gh-resolved)$/i;
  const check = (keys:string[]) => {
    if (keys.some(key => key && !safe.test(key) && !(catalog && metadata.test(key)))) {
      gitError("UNSUPPORTED_REPOSITORY_CONFIG");
    }
  };
  const keys = text.split("\0");
  check(keys);
  if (catalog && keys.some(key => key.toLowerCase() === "extensions.worktreeconfig")) {
    const scoped = await git(["config","--worktree","--no-includes","--null","--name-only","--get-regexp","."], {codes:[0,1]});
    check(scoped.text.split("\0"));
  }
}

export async function validateWorktree(path: string, signal?: AbortSignal, catalog = false) {
  const root = await directory(path);
  const git = gitRunner(root, signal);
  await safeConfig(git,catalog);
  const top = (await git(["rev-parse", "--show-toplevel"]).catch(() => gitError("INVALID_WORKTREE"))).text.replace(/\n$/, "");
  if (top !== root) gitError("INVALID_WORKTREE");
  return root;
}

async function validateBare(path: string, signal?: AbortSignal) {
  const root = await directory(path);
  const git = gitRunner(root, signal);
  await safeConfig(git);
  const result = await git(["rev-parse", "--is-bare-repository", "--absolute-git-dir"]);
  if (result.text !== "true\n" + root + "\n") gitError("INVALID_REMOTE");
  return root;
}

function parseStatus(text: string): GitResult["files"] {
  const records = text.split("\0");
  const files: NonNullable<GitResult["files"]> = [];
  for (const record of records) {
    if (record.startsWith("? ")) files.push({path: record.slice(2), index: "?", worktree: "?"});
    else if (record.startsWith("1 ") || record.startsWith("u ")) {
      const columns = record.charAt(0) === "1" ? 8 : 10;
      const offset = record.split(" ").slice(0, columns).join(" ").length + 1;
      files.push({path: record.slice(offset), index: record[2], worktree: record[3]});
    }
  }
  return files;
}

async function indexFingerprint(git:GitRun,index?:string) {
  const path = index ?? (await git(["rev-parse","--path-format=absolute","--git-path","index"])).text.replace(/\n$/,"");
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function worktreeIdentity(path:string,signal?:AbortSignal,catalog = false) {
  const root = await validateWorktree(path,signal,catalog);
  const run = gitRunner(root,signal);
  const admin = (await run(["rev-parse","--absolute-git-dir"])).text.replace(/\n$/,"");
  const settings = (await run(["rev-parse","--path-format=absolute","--git-common-dir"])).text.replace(/\n$/,"");
  const identifiers = await Promise.all([root,admin,settings].map(async path => {
    const entry = await stat(path,{bigint:true});
    return [entry.dev.toString(),entry.ino.toString()];
  }));
  return {
    root, identity:hash(JSON.stringify(identifiers)), repository:hash(JSON.stringify(identifiers[2])),
    repositoryName:basename(settings) === ".git" ? basename(dirname(settings)) : basename(settings).replace(/\.git$/, ""),
  };
}

export async function assertWorktree(path:string,expected:string,signal?:AbortSignal,catalog = false) {
  const state = await worktreeIdentity(path,signal,catalog);
  if (state.root !== path || state.identity !== expected) gitError("WORKTREE_REPLACED");
}

async function status(git: GitRun, root: string, index?: string): Promise<GitResult> {
  const observedIndex = await indexFingerprint(git,index);
  const {text} = await git(["status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"], {index});
  const records = text.split("\0");
  const header = (key: string) => records.find(record => record.startsWith("# branch." + key + " "))?.slice(10 + key.length) ?? null;
  const head = header("oid");
  const branch = header("head");
  const upstream = header("upstream");
  const ab = header("ab")?.match(/^\+(\d+) -(\d+)$/);
  const [entries,name,email] = await Promise.all([
    indexFingerprint(git,index),
    git(["config","--local","--get","user.name"],{codes:[0,1]}),
    git(["config","--local","--get","user.email"],{codes:[0,1]}),
  ]);
  if (observedIndex !== entries) return gitError("STALE_INDEX");
  const identity = author.safeParse({name:name.text.trim(),email:email.text.trim()});
  return {
    root, head: head === "(initial)" ? null : head, branch: branch === "(detached)" ? null : branch,
    upstream, author:identity.success ? identity.data : null, ...(ab ? {ahead: Number(ab[1]), behind: Number(ab[2])} : {}),
    snapshot: hash(JSON.stringify([head, branch, entries])), files: parseStatus(text),
  };
}

async function diff(git: GitRun, path: string, staged: boolean, index?: string) {
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
  let {text} = await git(["diff", ...flags, ...(staged ? ["--cached"] : []), "--", path], {index});
  if (!staged && text === "" && (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", path], {index})).text === path + "\0") {
    ({text} = await git(["diff", ...flags, "--no-index", "--", "/dev/null", path], {index, codes: [0, 1]}));
  }
  const matches = [...text.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm)];
  const header = text.slice(0, matches[0]?.index ?? 0);
  const hunks = !header.includes("\n--- a/") || !header.includes("\n+++ b/") || text.indexOf("\ndiff --git ") >= 0
    ? [] : matches.map((match, i) => ({
      token: hash(JSON.stringify([path, staged, hash(text), i])),
      text: text.slice(match.index, matches[i + 1]?.index),
    }));
  return {text, header, hunks};
}

async function lockedIndex<T>(git: GitRun, mutate: boolean, action: (index: string) => Promise<T>): Promise<T> {
  const path = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).text.replace(/\n$/, "");
  const lockPath = path + ".lock";
  const lock = await open(lockPath, "wx", 0o600).catch(() => gitError("INDEX_LOCKED"));
  let scratch: string | undefined;
  let committed = false;
  try {
    scratch = await mkdtemp(join(dirname(path), ".bb-index-"));
    const index = join(scratch, "index");
    await copyFile(path, index).catch(error => { if (!missing(error)) throw error; });
    const result = await action(index);
    if (mutate) {
      await copyFile(index, lockPath);
      await lock.sync();
      await rename(lockPath, path);
      committed = true;
    }
    return result;
  } finally {
    await lock.close();
    try {
      if (!committed) await rm(lockPath, {force: true});
    } finally {
      if (scratch) await rm(scratch, {recursive: true, force: true});
    }
  }
}

async function commitIndex(git: GitRun, root: string, message: string, expected: string, selected?: {name:string;email:string}) {
  return lockedIndex(git, false, async index => {
    const state = await status(git, root, index);
    if (state.snapshot !== expected) return gitError("STALE_INDEX");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      const path = (await git(["rev-parse", "--path-format=absolute", "--git-path", marker])).text.replace(/\n$/, "");
      if (await lstat(path).then(() => true, error => missing(error) ? false : Promise.reject(error))) return gitError("GIT_SEQUENCE_ACTIVE");
    }
    if (!state.files?.some(file => ![".", "?"].includes(file.index))) return gitError("NOTHING_STAGED");
    const identity = selected ?? state.author;
    if (!identity) return gitError("AUTHOR_REQUIRED");
    const tree = (await git(["write-tree"],{index})).text.trim();
    if (state.head && tree === (await git(["rev-parse","HEAD^{tree}"])).text.trim()) return gitError("NOTHING_STAGED");
    const symbolic = (await git(["symbolic-ref","--quiet","HEAD"],{codes:[0,1]})).text.trim();
    const ref = state.branch ? "refs/heads/" + state.branch : "HEAD";
    if (symbolic !== (state.branch ? ref : "")) return gitError("STALE_HEAD");
    const revision = (await git(["commit-tree",tree,...(state.head ? ["-p",state.head] : []),"-F","-"],{input:message,index,author:identity})).text.trim();
    // Ordinary Git checkout/switch honors the real index lock held above; the
    // old-value check protects the branch against writers of shared refs.
    const old = state.head ?? "0".repeat(tree.length);
    try {
      await git(["update-ref","--no-deref","-m","commit (BB Git Dashboard)",ref,revision,old]);
    } catch (error) {
      if (error instanceof Error && error.message === "GIT_REJECTED") return gitError("STALE_HEAD");
      throw error;
    }
    return revision;
  });
}

async function assertBranch(git: GitRun, branch: string) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(branch)) gitError("INVALID_BRANCH");
  await git(["check-ref-format", "refs/heads/" + branch]).catch(() => gitError("INVALID_BRANCH"));
}

async function listedWorktrees(git: GitRun) {
  return (await git(["worktree", "list", "--porcelain", "-z"])).text.split("\0\0").flatMap(block => {
    const lines = block.split("\0");
    const path = lines.find(line => line.startsWith("worktree "))?.slice(9);
    return path ? [{path, head: lines.find(line => line.startsWith("HEAD "))?.slice(5),
      branch: lines.find(line => line.startsWith("branch refs/heads/"))?.slice(18)}] : [];
  });
}

async function safeDestination(path: string, root: string) {
  if (!isAbsolute(path) || basename(path).startsWith(".") || basename(path).includes("\n")) gitError("INVALID_DESTINATION");
  const parent = await directory(dirname(path));
  const destination = join(parent, basename(path));
  if (within(root, destination)) gitError("INVALID_DESTINATION");
  if (await lstat(destination).then(() => true, error => missing(error) ? false : Promise.reject(error))) gitError("DESTINATION_EXISTS");
  return destination;
}

async function localOrigin(git: GitRun) {
  const remote = (await git(["remote", "get-url", "origin"]).catch(() => gitError("NO_ORIGIN"))).text.replace(/\n$/, "");
  // Network remotes require the selected account transport. This path accepts local bare fixtures.
  if (!isAbsolute(remote) || /[\r\n]/.test(remote)) gitError("ACCOUNT_TRANSPORT_REQUIRED");
  return validateBare(remote);
}

export async function cloneLocal(source: string, destination: string, signal?: AbortSignal) {
  const origin = await validateBare(source, signal);
  const target = await safeDestination(destination, origin);
  await gitRunner(dirname(target), signal)(["clone", "--no-local", "--no-recurse-submodules", "--", origin, target]);
  return validateWorktree(target, signal);
}

export async function localGit(path: string, action: GitAction, signal?: AbortSignal): Promise<GitResult> {
  const root = await validateWorktree(path, signal, action.kind === "worktrees");
  if (root !== path) gitError("INVALID_WORKTREE");
  const git = gitRunner(root, signal);
  switch (action.kind) {
    case "status": return status(git, root);
    case "history": return {root, text: (await git(["log", "-n", "75", "--format=%H %as %s", "--no-show-signature"], {codes: [0, 128]})).text};
    case "branches": return {root, text: (await git(["for-each-ref", "--format=%(refname:short) %(objectname) %(worktreepath)", "refs/heads", "refs/remotes"])).text};
    case "worktrees": return {root, worktrees: await listedWorktrees(git)};
    case "localOrigin": return {root, text: await localOrigin(git)};
    case "outgoing": {
      if (!(await status(git, root)).upstream) gitError("NO_UPSTREAM");
      return {root, text: (await git(["log", "-n", "75", "--format=%H %as %s", "@{upstream}..HEAD", "--"])).text};
    }
    case "diff": return {root, ...await diff(git, await filePath(root, action.path), action.staged)};
    case "compare": return {root, text: (await git(["diff", "--no-ext-diff", "--no-textconv", action.base, action.head, "--"])).text};
    case "hunk":
    case "stage": {
      const file = await filePath(root, action.path);
      await lockedIndex(git, true, async index => {
        const state = await status(git, root, index);
        const entry = state.files?.find(entry => entry.path === file);
        if (!entry) return gitError("INVALID_PATH");
        if (entry.index === "U" || entry.worktree === "U" || ["AA", "DD"].includes(entry.index + entry.worktree)) gitError("UNMERGED_PATH");
        if (action.kind === "hunk") {
          const current = await diff(git, file, action.staged, index);
          const selected = current.hunks.find(hunk => hunk.token === action.token);
          if (!selected) return gitError("STALE_HUNK");
          await git(["apply", "--cached", "--whitespace=nowarn", ...(action.staged ? ["--reverse"] : []), "-"], {input: current.header + selected.text, index});
        } else if (!action.staged) await git(["add", "--", file], {index});
        else if (state.head) await git(["reset", "-q", "HEAD", "--", file], {index});
        else await git(["rm", "--cached", "-f", "--", file], {index});
      });
      return status(git, root);
    }
    case "commit": {
      const head = await commitIndex(git,root,action.message,action.expected,action.author);
      return status(git,root).then(result => ({...result,head}), () => ({root,head}));
    }
    case "switch": {
      await assertBranch(git, action.branch);
      const occupied = (await listedWorktrees(git)).find(tree => tree.branch === action.branch && tree.path !== root);
      if (occupied) return {root, worktrees: [occupied], text: "BRANCH_OCCUPIED"};
      if ((await status(git, root)).files?.length) gitError("DIRTY_WORKTREE");
      await git(["switch", "--no-guess", "--", action.branch]);
      return status(git, root);
    }
    case "branch":
      await assertBranch(git, action.branch);
      await git(["branch", "--", action.branch, action.base]);
      return status(git, root);
    case "worktree": {
      await assertBranch(git, action.branch);
      const occupied = (await listedWorktrees(git)).find(tree => tree.branch === action.branch);
      if (occupied) return {root, worktrees: [occupied], text: "BRANCH_OCCUPIED"};
      const target = await safeDestination(action.destination, root);
      await git(["worktree", "add", ...(action.base ? ["-b", action.branch, "--", target, action.base] : ["--", target, action.branch])]);
      return {root, worktrees: await listedWorktrees(git)};
    }
    case "fetch": {
      const origin = await localOrigin(git);
      await git(["fetch", "--no-tags", "--no-recurse-submodules", "--", origin, "refs/heads/*:refs/remotes/origin/*"]);
      return status(git, root);
    }
    case "fastForward": {
      const state = await status(git, root);
      if (!state.upstream) gitError("NO_UPSTREAM");
      if (state.files?.length) gitError("DIRTY_WORKTREE");
      await git(["merge", "--ff-only", "--no-edit", "--no-autostash", "--no-verify-signatures", "@{upstream}"]);
      return status(git, root);
    }
    case "push": {
      const {branch, head} = await status(git, root);
      if (head !== action.expected || branch !== action.branch) return gitError("STALE_HEAD");
      await assertBranch(git, branch);
      const origin = await localOrigin(git);
      if (origin !== action.destination) return gitError("REMOTE_MISMATCH");
      await git(["push", "--no-follow-tags", "--recurse-submodules=no", "--", origin, head + ":refs/heads/" + branch]);
      return status(git, root);
    }
  }
}

async function httpsOrigin(clone: string, username: string) {
  const url = new URL(clone);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^[^\s\r\n:=]+$/.test(username)) {
    return gitError("INVALID_REMOTE");
  }
  // This transport explicitly selects a system credential helper. It never reads
  // personal Git configuration or falls back to a credential for another account.
  if (process.platform !== "darwin") return gitError("CREDENTIAL_HELPER_UNAVAILABLE");
  return {url:url.href, config:{username, helper:"osxkeychain"}};
}

export async function cloneHttps(clone: string, username: string, destination: string, signal?: AbortSignal) {
  const {url, config} = await httpsOrigin(clone, username);
  const target = await safeDestination(destination, "/dev/null");
  await gitRunner(dirname(target), signal, config)(["clone", "--no-recurse-submodules", "--", url, target]);
  return validateWorktree(target, signal);
}

export async function exchangeHttps(path: string, clone: string, username: string,
  action: {kind: "fetch"} | {kind: "push"; expected: string; branch: string}, signal?: AbortSignal) {
  const root = await validateWorktree(path, signal);
  if (root !== path) return gitError("INVALID_WORKTREE");
  const {url, config} = await httpsOrigin(clone, username);
  const git = gitRunner(root, signal, config);
  const origin = (await git(["remote", "get-url", "origin"]).catch(() => gitError("NO_ORIGIN"))).text.replace(/\n$/, "");
  if (origin !== url) return gitError("REMOTE_MISMATCH");
  if (action.kind === "fetch") {
    await git(["fetch", "--no-tags", "--no-recurse-submodules", "--", url, "refs/heads/*:refs/remotes/origin/*"]);
  } else {
    await assertBranch(git, action.branch);
    const current = await status(git, root);
    if (current.head !== action.expected || current.branch !== action.branch) return gitError("STALE_HEAD");
    await git(["push", "--no-follow-tags", "--recurse-submodules=no", "--", url, action.expected + ":refs/heads/" + action.branch]);
  }
  return status(git, root);
}

export async function checkOrigin(path: string, clone: string, signal?: AbortSignal) {
  const root = await validateWorktree(path,signal);
  if (root !== path) return gitError("INVALID_WORKTREE");
  const git = gitRunner(root,signal);
  const origin = (await git(["remote", "get-url", "origin"]).catch(() => gitError("NO_ORIGIN"))).text.replace(/\n$/, "");
  if (origin !== clone) return gitError("REMOTE_MISMATCH");
  return root;
}
