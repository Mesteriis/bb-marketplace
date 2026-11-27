// The project catalog: local projects of the projects folder and every account's repositories in one list, a remote
// repository marked when a local project has it as a remote. No I/O. The remote key and the config reading follow
// GitWand gitwand/v0.2.0 src/core/git-remotes.ts, the merge of sources its src/core/repo-catalog.ts (MIT).
import { parseRemote } from "../forge/remote-url.ts";
import type { Repo } from "../providers.ts";

/**
 * A remote URL as `host/path`, lower case, so a local clone (often SSH) and a forge listing (HTTPS) of the same
 * repository meet. Azure's SSH form `ssh.dev.azure.com:v3/org/project/name` is written as its HTTPS form.
 */
export function remoteKey(url: string): string | null {
  const remote = parseRemote(url);
  if (!remote || !remote.path.includes("/")) return null;
  const parts = remote.path.split("/");
  if (remote.host === "ssh.dev.azure.com" && parts[0] === "v3" && parts.length === 4) return ("dev.azure.com/" + parts[1] + "/" + parts[2] + "/_git/" + parts[3]).toLowerCase();
  return (remote.host + "/" + remote.path).toLowerCase();
}

/** Every `url` inside a `[remote "…"]` section of a git config file, origin's first: fetch and pull use origin. */
export function parseConfigRemotes(config: string): string[] {
  const urls: {name: string; url: string}[] = [];
  let remote: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { remote = /^\[remote\s+"([^"]*)"\]$/.exec(line)?.[1] ?? null; continue; }
    const match = remote !== null ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (match) urls.push({name: remote!, url: match[1]!.trim()});
  }
  return [...urls.filter(entry => entry.name === "origin"), ...urls.filter(entry => entry.name !== "origin")].map(entry => entry.url);
}

export type LocalProject = {path: string; name: string; remotes: string[]};
export type CatalogSource = {account: {id: string; label: string; kind: "github" | "gitlab" | "gitea" | "azure"}; ok: boolean; error: string | null;
  fetchedAt: string | null; repos: Repo[]};
export type RemoteRow = {key: string; repo: Repo; kind: CatalogSource["account"]["kind"]; accounts: string[]; localPath: string | null};

/** One catalog: local projects with their first forge key, remote repositories once each, and how each account answered. */
export function buildCatalog(local: readonly LocalProject[], sources: readonly CatalogSource[]) {
  const clones = new Map<string, string>();
  const rows = local.map(project => {
    const keys = project.remotes.map(remoteKey).filter((key): key is string => key !== null);
    for (const key of keys) if (!clones.has(key)) clones.set(key, project.path);
    return {path: project.path, name: project.name, key: keys[0] ?? null};
  });
  const remote = new Map<string, RemoteRow>();
  for (const {account, repos} of sources) {
    for (const repo of repos) {
      const key = remoteKey(repo.clone);
      if (!key) continue;
      const found = remote.get(key);
      if (found) { if (!found.accounts.includes(account.id)) found.accounts.push(account.id); continue; }
      remote.set(key, {key, repo, kind: account.kind, accounts: [account.id], localPath: clones.get(key) ?? null});
    }
  }
  return {
    local: rows,
    remote: [...remote.values()].sort((left, right) => left.key.localeCompare(right.key)),
    sources: sources.map(({account, ok, error, fetchedAt, repos}) => ({...account, ok, error, fetchedAt, count: repos.length})),
  };
}

/** A new listing over the last: a source that failed keeps the repositories (and time) it listed before, and says it failed. */
export function keepFailedSources(previous: readonly CatalogSource[], next: readonly CatalogSource[]): CatalogSource[] {
  const before = new Map(previous.map(source => [source.account.id, source]));
  return next.map(source => {
    const old = before.get(source.account.id);
    return source.ok || !old?.repos.length ? source : {...source, fetchedAt: old.fetchedAt, repos: old.repos};
  });
}

const segment = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** The folders of the projects folder that hold projects (`OSS`, `Work/team`), the folder itself as "", sorted. */
export function categoriesOf(root: string, projects: readonly string[]): string[] {
  const base = root.replace(/\/+$/, "");
  const folders = new Set<string>([""]);
  for (const path of projects) {
    if (!path.startsWith(base + "/")) continue;
    const parts = path.slice(base.length + 1).split("/");
    parts.pop();
    // Only folders a clone can go into (see clonePath): a space or other sign in a name leaves the folder out.
    if (parts.length && parts.every(part => segment.test(part))) folders.add(parts.join("/"));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

/** Where a clone goes: a category folder of the projects folder and a new folder name; null when either would leave it. */
export function clonePath(root: string, category: string, name: string): string | null {
  const parts = category === "" ? [] : category.split("/");
  if (!segment.test(name) || parts.some(part => !segment.test(part))) return null;
  return [root.replace(/\/+$/, ""), ...parts, name].join("/");
}
