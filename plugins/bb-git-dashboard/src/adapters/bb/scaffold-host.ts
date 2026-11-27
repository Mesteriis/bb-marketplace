import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { clonePath } from "../../core/catalog/catalog.ts";
import { projectsFolder } from "./catalog-host.ts";
import { gitRunner } from "./git-process.ts";
import { assertWorktree, exchangeHttps, worktreeIdentity } from "./local-git.ts";

const fail = (code: string): never => { throw new Error(code); };
export type ScaffoldFileWrite = {path: string; text: string; executable: boolean};

/** A relative path of plain segments inside the project, never into `.git`. */
const relative = (path: string) => {
  const parts = path.split("/");
  // .git in any case and at any depth: on a case-insensitive disk .GIT is the repository's own folder.
  if (!path || parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || part.toLowerCase() === ".git")) fail("INVALID_PATH");
  return parts;
};

/**
 * Makes a new project from a scaffold's files: the folder `<projects folder>/<category>/<name>` (the category must
 * exist inside the projects folder and the folder must not), the files (no links followed, read-write for the owner and
 * readable by others, executable where marked), `git init` on main and one commit by the given author. If any step
 * fails, the folder made here is removed again.
 */
export async function scaffoldCreate(projectsRoot: string, category: string, name: string, files: ScaffoldFileWrite[],
  author: {name: string; email: string}, message: string, signal?: AbortSignal) {
  const folder = await projectsFolder(projectsRoot);
  const target = clonePath(folder, category, name) ?? fail("INVALID_DESTINATION");
  const parent = await realpath(dirname(target)).catch(() => fail("INVALID_DESTINATION"));
  if (parent !== dirname(target) || (parent !== folder && !parent.startsWith(folder + sep))) fail("INVALID_DESTINATION");
  // A category is a folder that holds projects, not a project: nothing between the projects folder and the new one has .git.
  for (let dir = parent; dir !== folder && dir.startsWith(folder + sep); dir = dirname(dir))
    if (await lstat(join(dir, ".git")).then(() => true, () => false)) fail("INVALID_DESTINATION");
  if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) fail("DESTINATION_EXISTS");
  await mkdir(target);
  try {
    for (const file of files) {
      const path = join(target, ...relative(file.path));
      await mkdir(dirname(path), {recursive: true});
      // "wx" refuses a path that exists, a link included; the mode is set on the handle, past the umask.
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(file.text); await handle.chmod(file.executable ? 0o755 : 0o644); }
      finally { await handle.close(); }
    }
    const git = gitRunner(target, signal);
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "--no-verify", "-m", message], {author});
    return await worktreeIdentity(target, signal);
  } catch (error) {
    await rm(target, {recursive: true, force: true});
    throw error;
  }
}

type Exchange = (path: string, clone: string, username: string, action: {kind: "push"; expected: string; branch: string}, signal?: AbortSignal) => Promise<unknown>;

/**
 * The first push of a project made from a scaffold to its new forge repository: origin is set to the plain clone
 * address (never with a credential in it; an origin already there must be that address), main is pushed over HTTPS
 * with the account's credential from the system helper, as fetch and push do, and main then follows origin/main.
 */
export async function publishFirst(root: string, identity: string, clone: string, username: string, exchange: Exchange = exchangeHttps,
  signal?: AbortSignal) {
  await assertWorktree(root, identity, signal);
  const url = new URL(clone);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("INVALID_REMOTE");
  const git = gitRunner(root, signal);
  const origin = (await git(["remote", "get-url", "origin"], {codes: [0, 2, 128]})).text.replace(/\n$/, "");
  if (!origin) await git(["remote", "add", "origin", url.href]);
  else if (origin !== url.href) fail("REMOTE_MISMATCH");
  if ((await git(["branch", "--show-current"])).text.trim() !== "main") fail("STALE_HEAD");
  const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).text.trim();
  await exchange(root, url.href, username, {kind: "push", expected: head, branch: "main"}, signal);
  await git(["update-ref", "refs/remotes/origin/main", head]);
  await git(["config", "branch.main.remote", "origin"]);
  await git(["config", "branch.main.merge", "refs/heads/main"]);
}
