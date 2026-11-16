// BB projects as Mail sees them (slice 3g): the repository a project's remote
// names and the single local checkout Mail may write into. Pure; the adapter
// reads bb.sdk.projects and builds ProjectInfo.

/** A repository by host and path ("owner/repo", GitLab subgroups kept). */
export type RepoRef = { host: string; path: string };

export type ProjectInfo = {
  id: string;
  name: string;
  kind: string;
  remote: RepoRef | null;
  tree: { hostId: string; path: string } | null;
};

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function repoPath(raw: string): string | null {
  if (/[\s?#\\]/.test(raw)) return null;
  let path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  const segments = path.split("/");
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function ref(rawHost: string, rawPath: string): RepoRef | null {
  const host = rawHost.toLowerCase();
  if (!HOST.test(host)) return null;
  const path = repoPath(rawPath);
  return path === null ? null : { host, path };
}

/**
 * The repository of a remote URL: https://host[:port]/owner/repo(.git),
 * git@host:owner/repo(.git) or ssh://[user@]host[:port]/owner/repo. The port
 * and any user info are dropped; null for anything else.
 */
export function repoRefOf(url: string): RepoRef | null {
  const value = url.trim();
  const remote = /^(https|ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d{1,5})?(\/.*)$/i.exec(value);
  if (remote !== null) return ref(remote[2]!, remote[3]!);
  const scp = /^[A-Za-z0-9._-]+@([^/:\s]+):(.+)$/.exec(value);
  if (scp !== null) return ref(scp[1]!, scp[2]!);
  return null;
}

/** The same repository: hosts equal, paths equal ignoring case. */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.host === b.host && a.path.toLowerCase() === b.path.toLowerCase();
}

/** A project source as the adapter reads it. */
export type ProjectSourceLike = { type: string; hostId: string; path: string; isDefault: boolean };

/** The default local_path source, or the only one; null for none, or several without one default. */
export function workingTree(sources: readonly ProjectSourceLike[]): { hostId: string; path: string } | null {
  const local = sources.filter((source) => source.type === "local_path");
  const defaults = local.filter((source) => source.isDefault);
  const chosen = defaults.length === 1 ? defaults[0]! : local.length === 1 ? local[0]! : null;
  return chosen === null ? null : { hostId: chosen.hostId, path: chosen.path };
}
