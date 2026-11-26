// The repository catalog GitWand's "Repositories" dialog shows: local
// repositories from the scan and remote ones from gh and glab, one entry per
// repository, with remote entries marked when a local clone exists.
import { z } from "zod";
import type { LocalRepo } from "./repo-scan.ts";

export type GitProtocol = "ssh" | "https";

export interface RemoteRepoData {
  fullName: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  webUrl: string;
  updatedAt: string | null;
}

export interface RemoteSource {
  /** "github.com/<account>" for GitHub, the host for GitLab. */
  id: string;
  kind: "github" | "gitlab";
  host: string;
  account: string | null;
}

export interface RemoteSourceResult {
  source: RemoteSource;
  ok: boolean;
  /** A fixed message: never a CLI's output, which may carry credentials. */
  error: string | null;
  fetchedAt: string | null;
  repos: RemoteRepoData[];
}

/** The fields `gh api --jq` keeps from /user/repos. */
export const GH_REPO_JQ = ".[] | {full_name, description, private, archived, fork, ssh_url, clone_url, html_url, pushed_at}";

const text = z.string().min(1);
const optionalText = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null));

const ghRepo = z.object({
  full_name: text,
  description: optionalText,
  private: z.boolean(),
  archived: z.boolean().optional().default(false),
  fork: z.boolean().optional().default(false),
  ssh_url: text,
  clone_url: text,
  html_url: text,
  pushed_at: optionalText,
});

const glabProject = z.object({
  path_with_namespace: text,
  description: optionalText,
  visibility: z.string().optional(),
  archived: z.boolean().optional().default(false),
  forked_from_project: z.unknown().optional(),
  ssh_url_to_repo: text,
  http_url_to_repo: text,
  web_url: text,
  last_activity_at: optionalText,
});

function ndjson<T>(out: string, schema: z.ZodType<T>): T[] {
  const items: T[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

export function parseGhRepos(out: string, options: { host: string; protocol: GitProtocol }): RemoteRepoData[] {
  return ndjson(out, ghRepo).map((r) => ({
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    archived: r.archived,
    fork: r.fork,
    cloneUrl: options.protocol === "ssh" ? r.ssh_url : r.clone_url,
    webUrl: r.html_url,
    updatedAt: r.pushed_at,
  }));
}

export function parseGlabProjects(out: string, options: { host: string; protocol: GitProtocol }): RemoteRepoData[] {
  return ndjson(out, glabProject).map((p) => ({
    fullName: p.path_with_namespace,
    description: p.description,
    private: p.visibility !== "public",
    archived: p.archived,
    fork: p.forked_from_project != null,
    cloneUrl: options.protocol === "ssh" ? p.ssh_url_to_repo : p.http_url_to_repo,
    webUrl: p.web_url,
    updatedAt: p.last_activity_at,
  }));
}

// ─── The catalog on the wire (and in the plugin's cache file) ─────────────

export const localEntrySchema = z.object({ path: z.string(), name: z.string(), remote: z.string().nullable() }).strict();

export const remoteEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["github", "gitlab"]),
    host: z.string(),
    fullName: z.string(),
    description: z.string().nullable(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
    cloneUrl: z.string(),
    webUrl: z.string(),
    updatedAt: z.string().nullable(),
    /** Source ids that list it (one repository can be visible to two accounts). */
    sources: z.array(z.string()),
    localPath: z.string().nullable(),
  })
  .strict();

export const sourceEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(["github", "gitlab"]),
    host: z.string(),
    account: z.string().nullable(),
    ok: z.boolean(),
    error: z.string().nullable(),
    count: z.number().int().nonnegative(),
    fetchedAt: z.string().nullable(),
  })
  .strict();

export type LocalEntry = z.infer<typeof localEntrySchema>;
export type RemoteEntry = z.infer<typeof remoteEntrySchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;

export function buildCatalog(input: { local: LocalRepo[]; sources: RemoteSourceResult[] }): { local: LocalEntry[]; remote: RemoteEntry[]; sources: SourceEntry[] } {
  const clones = new Map<string, string>();
  for (const repo of input.local) for (const key of repo.keys) if (!clones.has(key)) clones.set(key, repo.path);

  const remote = new Map<string, RemoteEntry>();
  for (const { source, repos } of input.sources) {
    for (const r of repos) {
      const id = `${source.host}/${r.fullName}`.toLowerCase();
      const existing = remote.get(id);
      if (existing !== undefined) {
        if (!existing.sources.includes(source.id)) existing.sources.push(source.id);
        continue;
      }
      remote.set(id, { id, kind: source.kind, host: source.host, ...r, sources: [source.id], localPath: clones.get(id) ?? null });
    }
  }

  return {
    local: input.local.map((r) => ({ path: r.path, name: r.name, remote: r.keys[0] ?? null })),
    remote: [...remote.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    sources: input.sources.map(({ source, ok, error, fetchedAt, repos }) => ({ ...source, ok, error, count: repos.length, fetchedAt })),
  };
}

export const catalogSchema = z
  .object({
    local: z.array(localEntrySchema),
    remote: z.array(remoteEntrySchema),
    sources: z.array(sourceEntrySchema),
    roots: z.array(z.object({ root: z.string(), ok: z.boolean() }).strict()),
    /** The scan stopped at its repository limit. */
    truncated: z.boolean(),
    scannedAt: z.string(),
  })
  .strict();

export type Catalog = z.infer<typeof catalogSchema>;

const remoteRepoDataSchema = z
  .object({
    fullName: z.string(),
    description: z.string().nullable(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
    cloneUrl: z.string(),
    webUrl: z.string(),
    updatedAt: z.string().nullable(),
  })
  .strict();

/** The plugin's cache of the last remote listing (repository names and URLs, no credentials). */
export const remoteCacheSchema = z.array(
  z
    .object({
      source: z.object({ id: z.string(), kind: z.enum(["github", "gitlab"]), host: z.string(), account: z.string().nullable() }).strict(),
      ok: z.boolean(),
      error: z.string().nullable(),
      fetchedAt: z.string().nullable(),
      repos: z.array(remoteRepoDataSchema),
    })
    .strict(),
);

/**
 * A new listing over the previous one: a source that failed now keeps the
 * repositories it listed last time (with their time) and shows the error.
 */
export function mergeRemoteResults(previous: RemoteSourceResult[], next: RemoteSourceResult[]): RemoteSourceResult[] {
  const before = new Map(previous.map((r) => [r.source.id, r]));
  return next.map((r) => {
    const old = before.get(r.source.id);
    if (r.ok || old === undefined || old.repos.length === 0) return r;
    return { ...r, fetchedAt: old.fetchedAt, repos: old.repos };
  });
}
