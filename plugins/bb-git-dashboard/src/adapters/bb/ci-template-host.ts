import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { manifestPaths } from "../../core/ci-templates/stack.ts";
import { gitRunner } from "./git-process.ts";

const largest = 64 * 1024;
const ciFiles = [".github/workflows", ".gitea/workflows", ".gitlab-ci.yml", "azure-pipelines.yml"];
const names = (text: string) => text.split("\0").filter(Boolean);

/**
 * What a project's stack is told by, as committed at HEAD: the root entries, the CI files already there and the root
 * manifests up to 64 KB each. The working copy's edits are not read: the new branch starts from a commit.
 */
export async function ciStack(root: string, signal?: AbortSignal) {
  const git = gitRunner(root, signal);
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {codes: [0, 1]})).text.trim() || null;
  if (!head) return {head: null, paths: [], manifests: {}};
  const top = names((await git(["ls-tree", "-z", "--name-only", head])).text);
  const ci = names((await git(["ls-tree", "-r", "-z", "--name-only", head, "--", ...ciFiles])).text);
  const manifests: Record<string, string> = {};
  for (const path of manifestPaths(top)) {
    const size = Number((await git(["cat-file", "-s", head + ":" + path], {codes: [0, 128]})).text.trim());
    if (!Number.isFinite(size) || size > largest) continue;
    manifests[path] = (await git(["cat-file", "blob", head + ":" + path], {limit: largest})).text;
  }
  return {head, paths: [...new Set([...ci, ...top])].sort(), manifests};
}

/** The JSON files of the own templates folder: at most 50, each a regular file up to 64 KB; the rest are named as skipped. */
export async function ciTemplateFolder(folder: string) {
  const path = folder === "~" || folder.startsWith("~/") ? homedir() + folder.slice(1) : folder;
  if (!isAbsolute(path)) throw new Error("INVALID_PATH");
  let entries: string[];
  try { entries = (await readdir(path)).filter(name => name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {files: [], skipped: []}; throw new Error("INVALID_PATH"); }
  const files: {name: string; text: string}[] = [];
  const skipped: string[] = [];
  for (const name of entries) {
    const info = await lstat(join(path, name));
    if (!info.isFile() || info.size > largest || files.length >= 50) { skipped.push(name); continue; }
    files.push({name, text: await readFile(join(path, name), "utf8")});
  }
  return {files, skipped};
}
