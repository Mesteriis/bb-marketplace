import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { parseConfigRemotes, type LocalProject } from "../../core/catalog/catalog.ts";
import { maxDepth } from "../../core/catalog/project-scan.ts";
import { parseRemote } from "../../core/forge/remote-url.ts";
import type { GitResult } from "../../core/git.ts";
import { gitRunner, type Transport } from "./git-process.ts";
import { localGit, originUrl, validateWorktree } from "./local-git.ts";
import { walkProjects } from "./project-walk.ts";
import { sshHostname } from "./ssh-config.ts";

const fail = (code: string): never => { throw new Error(code); };
/** The projects folder as set (`~` is the home folder of this machine), resolved through links. */
export async function projectsFolder(root: string) {
  const folder = root === "~" || root.startsWith("~/") ? homedir() + root.slice(1) : root;
  if (!isAbsolute(folder)) fail("INVALID_PATH");
  return realpath(folder).catch(() => fail("INVALID_PATH"));
}

/**
 * The projects of the projects folder with their remote URLs, read from each `.git/config` without running Git. An
 * SSH alias (a host without a dot) is written with the host `ssh -G` names, so it meets the forge's listing.
 */
export async function catalogLocal(root: string, exclude: string[], signal?: AbortSignal, resolveAlias = sshHostname) {
  const folder = await projectsFolder(root);
  const {verdicts, truncated} = await walkProjects(folder, {exclude, maxDepth}, undefined, signal);
  const aliases = new Map<string, Promise<string | null>>();
  const named = async (url: string) => {
    const remote = parseRemote(url);
    if (!remote || remote.transport !== "ssh" || remote.host.includes(".") || url.includes("://")) return url;
    if (!aliases.has(remote.host)) aliases.set(remote.host, resolveAlias(remote.host).catch(() => null));
    const host = await aliases.get(remote.host);
    return host ? "git@" + host + ":" + remote.path : url;
  };
  const projects: LocalProject[] = [];
  for (const verdict of verdicts) {
    if (verdict.kind !== "project") continue;
    const config = await readFile(join(verdict.path, ".git", "config"), "utf8").then(text => text.slice(0, 64 * 1024), () => "");
    projects.push({path: verdict.path, name: basename(verdict.path), remotes: await Promise.all(parseConfigRemotes(config).slice(0, 10).map(named))});
  }
  return {root: folder, projects, truncated};
}

/** A working copy inside the projects folder (checked here, on the machine), as Git's own root. */
async function inside(projectsRoot: string, root: string, signal?: AbortSignal) {
  const folder = await projectsFolder(projectsRoot);
  const real = await realpath(root).catch(() => fail("INVALID_WORKTREE"));
  if (real === folder || !real.startsWith(folder + sep)) fail("OUTSIDE_PROJECTS");
  return validateWorktree(real, signal);
}

export type CatalogGitAction = "status" | "fetch" | "pull";

/**
 * Status, fetch or pull (fast-forward only) of one project of the catalog. Fetch reaches the origin over SSH with the
 * user's keys in batch mode, or over HTTPS with the account `https` names (its username and credential helper).
 */
export async function catalogGit(projectsRoot: string, root: string, action: CatalogGitAction, https: {username: string} | null, signal?: AbortSignal): Promise<GitResult> {
  const project = await inside(projectsRoot, root, signal);
  if (action === "status") return localGit(project, {kind: "status"}, signal);
  const origin = await originUrl(project, signal);
  const remote = parseRemote(origin);
  const transport: Transport | null = !remote ? null : remote.transport === "ssh" ? {ssh: true}
    : https ? {username: https.username, helper: "osxkeychain"} : null;
  if (!transport) fail(remote ? "ACCOUNT_TRANSPORT_REQUIRED" : "NO_ORIGIN");
  if ("helper" in transport! && process.platform !== "darwin") fail("CREDENTIAL_HELPER_UNAVAILABLE");
  // The configured origin (its URL already checked by the copy's safe config), its branches only, no tags or submodules.
  await gitRunner(project, signal, transport!)(["fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], {timeout: 2 * 60_000});
  if (action === "pull") {
    const state = await localGit(project, {kind: "status"}, signal);
    // Only a branch that follows origin was brought up to date by this fetch: one following another remote is left as it is.
    if (state.upstream?.startsWith("origin/") && !state.files?.length && (state.behind ?? 0) > 0) return localGit(project, {kind: "fastForward"}, signal);
    return state;
  }
  return localGit(project, {kind: "status"}, signal);
}
