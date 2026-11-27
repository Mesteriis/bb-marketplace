// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// Which BB thread or project a pull request belongs to. No I/O.
import { parseRemote, providerPath } from "../forge/remote-url.ts";
import type { Forge } from "./model.ts";

export function repoOfRemote(remote: string | null): string | null {
  const match = remote?.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** The fields of bb's `threads.list` rows that pick a PR's thread. */
export interface AgentThread {
  id: string;
  projectId: string;
  environmentId: string | null;
  environmentBranchName: string | null;
  archivedAt: number | null;
  updatedAt: number;
  title: string | null;
  titleFallback: string | null;
}

/**
 * Where "Fix with agent" goes: the most recently updated thread whose environment is on the PR's head
 * branch in the PR's repo, confirmed by bb's GitHub PR Status answer for that environment when it has one,
 * else by the project's git remote; and, for a new thread, the project whose remote is the PR's repo.
 */
export function agentTarget(
  pr: { url: string; repo: string; headRefName: string },
  threads: readonly AgentThread[],
  projects: readonly { id: string; gitRemoteUrl: string | null; name?: string }[],
  prUrlByEnvironment: Readonly<Record<string, string>>,
): { thread: { id: string; title: string } | null; projectId: string | null } {
  const repo = pr.repo.toLowerCase();
  const remotes = new Map(projects.map((p) => [p.id, repoOfRemote(p.gitRemoteUrl)]));
  const owner = threads
    .filter((t) => {
      if (t.archivedAt !== null || t.environmentId === null || t.environmentBranchName !== pr.headRefName) return false;
      const known = prUrlByEnvironment[t.environmentId];
      return known !== undefined ? known.toLowerCase() === pr.url.toLowerCase() : remotes.get(t.projectId) === repo;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    thread: owner ? { id: owner.id, title: owner.title ?? owner.titleFallback ?? "the PR's thread" } : null,
    projectId: projectFor(pr.repo, projects),
  };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The bb project a PR belongs to: the one whose git remote is the repo; else one named like the repo
 * ("Billing API" for acme/billing-api); else one whose name contains it or is contained in it.
 */
export function projectFor(repo: string, projects: readonly { id: string; gitRemoteUrl: string | null; name?: string }[]): string | null {
  const lower = repo.toLowerCase();
  const byRemote = projects.find((p) => repoOfRemote(p.gitRemoteUrl) === lower);
  if (byRemote) return byRemote.id;
  const name = squash(repo.split("/")[1] ?? repo);
  if (name.length < 3) return null;
  const named = projects.filter((p) => p.name);
  const exact = named.find((p) => squash(p.name!) === name);
  if (exact) return exact.id;
  // Only a single close match counts: two candidates means guessing.
  const close = named.filter((p) => {
    const n = squash(p.name!);
    return n.length >= 4 && (n.includes(name) || name.includes(n));
  });
  return close.length === 1 ? close[0]!.id : null;
}

/** Threads to offer under "Link to thread": the PR's branch thread, then its project's, then the rest, newest first. */
export function linkCandidates(
  threads: readonly AgentThread[],
  projects: readonly { id: string; name?: string }[],
  target: { thread: { id: string } | null; projectId: string | null },
  limit = 60,
): { id: string; title: string; project: string; updatedAt: number }[] {
  const names = new Map(projects.map((p) => [p.id, p.name ?? ""]));
  const rank = (t: AgentThread) => (t.id === target.thread?.id ? 0 : t.projectId === target.projectId ? 1 : 2);
  return threads
    .filter((t) => t.archivedAt === null)
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((t) => ({ id: t.id, title: t.title ?? t.titleFallback ?? "Untitled thread", project: names.get(t.projectId) ?? "", updatedAt: t.updatedAt }));
}


// ---- Any forge (Makosh Git): projects by their remote, the thread on the pull request's branch ----


/** Projects whose git remote is this repository, on any forge, compared by provider path. */
export function projectsOfRepo(forge: Forge, path: string, projects: readonly {id: string; gitRemoteUrl: string | null}[]): string[] {
  const wanted = path.toLowerCase();
  return projects.filter(project => {
    const remote = project.gitRemoteUrl ? parseRemote(project.gitRemoteUrl) : null;
    return remote !== null && providerPath(forge, remote)?.toLowerCase() === wanted;
  }).map(project => project.id);
}

/** The most recently updated open thread of these projects whose environment is on the branch. */
export function branchThread(threads: readonly AgentThread[], projectIds: readonly string[], branch: string): string | null {
  return threads.filter(thread => thread.archivedAt === null && projectIds.includes(thread.projectId) && thread.environmentBranchName === branch)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null;
}

/**
 * Where Fix with agent goes: the newest thread on the pull request's branch in one of its projects, else a new thread
 * in a managed worktree started from the head branch. A fork's branch lives in another repository, so a fork never
 * reuses a base-repository thread and its worktree starts from the default branch.
 */
export function agentPlan(pr: {headRefName: string; fromFork?: boolean}, projectIds: readonly string[], threads: readonly AgentThread[]):
  {send: string} | {spawn: {projectId: string; baseBranch: string | null}} | {error: "PROJECT_REQUIRED"} {
  const existing = pr.fromFork ? null : branchThread(threads, projectIds, pr.headRefName);
  if (existing) return {send: existing};
  if (!projectIds.length) return {error: "PROJECT_REQUIRED"};
  return {spawn: {projectId: projectIds[0], baseBranch: pr.fromFork ? null : pr.headRefName}};
}

/**
 * The machine a new "Fix with agent" thread starts its worktree on: where the project's working copy is (its first
 * source), else where one of its environments holds a git checkout; null when it has neither.
 */
export function spawnHost(project: {sources: readonly {hostId: string}[]} | undefined,
  environments: readonly {hostId?: string | null; isGitRepo?: boolean; isWorktree?: boolean}[]): string | null {
  const source = project?.sources.find(item => item.hostId)?.hostId;
  if (source) return source;
  return environments.find(environment => environment.hostId && (environment.isGitRepo || environment.isWorktree))?.hostId ?? null;
}
