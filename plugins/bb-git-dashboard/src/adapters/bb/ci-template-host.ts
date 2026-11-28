import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { manifestPaths } from "../../core/ci-templates/stack.ts";
import { gitRunner } from "./git-process.ts";

const largest = 64 * 1024;
const ciFiles = [".github/workflows", ".gitea/workflows", ".gitlab-ci.yml", ".gitlab/ci", "azure-pipelines.yml", ".azure-pipelines"];
const names = (text: string) => text.split("\0").filter(Boolean);

/**
 * What a project's stack is told by, as committed: the root entries, the CI files already there and the root manifests
 * up to 64 KB each. They are read at `origin/<branch>` — the forge's default branch as last fetched, which the new
 * branch starts from — or at HEAD when the copy has no such ref. The working copy's edits are not read.
 */
export async function ciStack(root: string, branch?: string, signal?: AbortSignal) {
  const git = gitRunner(root, signal);
  const resolve = async (ref: string) => (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}"], {codes: [0, 1]})).text.trim() || null;
  const fetched = branch && /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,249}$/.test(branch) ? await resolve("refs/remotes/origin/" + branch) : null;
  const ref = fetched ? "origin/" + branch : "HEAD";
  const head = fetched ?? await resolve("HEAD");
  if (!head) return {ref, head: null, paths: [], manifests: {}};
  const top = names((await git(["ls-tree", "-z", "--name-only", head])).text);
  const ci = names((await git(["ls-tree", "-r", "-z", "--name-only", head, "--", ...ciFiles])).text);
  // The application folders src/<role>/ (at most 20) and their own entries, where a project without root manifests keeps them.
  const apps: string[] = [];
  if (top.includes("src")) {
    const folders = (await git(["ls-tree", "-z", head, "--", "src/"])).text.split("\0").filter(Boolean)
      .filter(line => / tree [0-9a-f]+\t/.test(line)).map(line => line.slice(line.indexOf("\t") + 1)).slice(0, 20);
    apps.push(...folders);
    for (const folder of folders) apps.push(...names((await git(["ls-tree", "-z", "--name-only", head, "--", folder + "/"])).text));
  }
  const manifests: Record<string, string> = {};
  for (const path of manifestPaths([...top, ...apps])) {
    // A name that is no file at the root (a submodule, a folder) has no blob to read.
    const type = await git(["cat-file", "-t", head + ":" + path], {codes: [0, 128]});
    if (type.code !== 0 || type.text.trim() !== "blob") continue;
    const size = Number((await git(["cat-file", "-s", head + ":" + path])).text.trim());
    if (!Number.isFinite(size) || size > largest) continue;
    manifests[path] = (await git(["cat-file", "blob", head + ":" + path], {limit: largest})).text;
  }
  return {ref, head, paths: [...new Set([...ci, ...top, ...apps])].sort(), manifests};
}

/** Reads a regular file without following a link, refusing one over `largest` bytes; null when it is not one. */
async function readSmall(path: string): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > largest) return null;
    const buffer = Buffer.alloc(largest + 1);
    const {bytesRead} = await handle.read(buffer, 0, largest + 1, 0);
    return bytesRead > largest ? null : buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
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
    const text = files.length < 50 ? await readSmall(join(path, name)) : null;
    if (text === null) skipped.push(name); else files.push({name, text});
  }
  return {files, skipped};
}
