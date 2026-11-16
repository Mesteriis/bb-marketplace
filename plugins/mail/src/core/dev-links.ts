// Repository, pull request, issue and CI links in a message (slice 3g, #36):
// found in the plain body and in the HTML's href values, https only, mapped
// to BB projects by their remotes. The shown text is always the URL itself,
// never the anchor text. Pure.
import { sameRepo, type RepoRef } from "./projects.ts";
import { redactSecrets } from "./redact.ts";

export const DEV_LINKS_MAX = 20;
/** Longest URL looked at. */
const URL_MAX = 2_000;
/** Longest stored (normalized) URL; a longer one is not a dev link. */
export const DEV_LINK_URL_MAX = 300;
/** Whitespace (any) and control characters: an href holding one is dropped, never cleaned. */
const UNSAFE_IN_URL = /[\s\u0000-\u001f\u007f-\u009f]/u;

export const DEV_LINK_KINDS = [
  "repo", "pr", "issue", "commit", "run", "release", "compare", "mr", "pipeline", "tracker",
] as const;
export type DevLinkKind = (typeof DEV_LINK_KINDS)[number];

export type DevLink = {
  url: string;
  kind: DevLinkKind;
  repo: RepoRef | null;
  /** The PR, issue, MR, run or pipeline number, the commit sha, the release tag or the tracker key. */
  number: string | null;
  projectId: string | null;
};

export type ProjectRemote = { projectId: string; remote: RepoRef };

/** First path segments of github.com and gitlab.com that are the site's own pages, not owners. */
const RESERVED_OWNERS = new Set([
  "about", "account", "apps", "blog", "collections", "contact", "customer-stories", "dashboard", "enterprise",
  "events", "explore", "features", "help", "issues", "login", "marketplace", "new", "notifications", "orgs",
  "organizations", "pricing", "pulls", "readme", "search", "security", "settings", "site", "sponsors", "topics",
  "trending", "users", "-",
]);

/** URLs in plain text: one character class, so no backtracking; trailing punctuation dropped. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]{}]+/gi;

function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?".includes(url[end - 1]!)) end--;
  return url.slice(0, end);
}

const NUMBER = /^\d{1,12}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const TRACKER_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

type Parsed = { kind: DevLinkKind; repo: RepoRef | null; number: string | null };

/** GitHub's shapes after /owner/repo. */
function githubShape(host: string, segments: string[]): Parsed | null {
  if (segments.length < 2) return null;
  const [owner, name, ...rest] = segments as [string, string, ...string[]];
  const repo = { host, path: `${owner}/${name}` };
  const [first, second, third] = rest;
  if (first === undefined) return { kind: "repo", repo, number: null };
  if (first === "pull" && second !== undefined && NUMBER.test(second)) return { kind: "pr", repo, number: second };
  if (first === "issues" && second !== undefined && NUMBER.test(second)) return { kind: "issue", repo, number: second };
  if (first === "commit" && second !== undefined && SHA.test(second)) return { kind: "commit", repo, number: second };
  if (first === "actions" && second === "runs" && third !== undefined && NUMBER.test(third)) {
    return { kind: "run", repo, number: third };
  }
  if (first === "releases" && second === "tag" && third !== undefined && third !== "") return { kind: "release", repo, number: third };
  if (first === "compare" && second !== undefined && second !== "") return { kind: "compare", repo, number: null };
  return null;
}

/** GitLab's shapes: /group/.../project/-/kind/N, or the project itself. */
function gitlabShape(host: string, segments: string[]): Parsed | null {
  const dash = segments.indexOf("-");
  if (dash === -1) return segments.length >= 2 ? { kind: "repo", repo: { host, path: segments.join("/") }, number: null } : null;
  if (dash < 2) return null;
  const repo = { host, path: segments.slice(0, dash).join("/") };
  const [kind, value] = segments.slice(dash + 1);
  if (value === undefined) return null;
  if (kind === "merge_requests" && NUMBER.test(value)) return { kind: "mr", repo, number: value };
  if (kind === "issues" && NUMBER.test(value)) return { kind: "issue", repo, number: value };
  if (kind === "pipelines" && NUMBER.test(value)) return { kind: "pipeline", repo, number: value };
  if (kind === "commit" && SHA.test(value)) return { kind: "commit", repo, number: value };
  return null;
}

function forgeShape(host: string, segments: string[], remoteHosts: ReadonlySet<string>): Parsed | null {
  if (segments.length === 0 || RESERVED_OWNERS.has(segments[0]!.toLowerCase())) return null;
  if (host === "github.com") return githubShape(host, segments);
  if (host === "gitlab.com") return gitlabShape(host, segments);
  if (!remoteHosts.has(host)) return null;
  // A remote's host may run either forge: GitLab paths carry "/-/".
  if (segments.includes("-")) return gitlabShape(host, segments);
  const github = githubShape(host, segments);
  return github !== null && github.kind !== "repo" ? github : gitlabShape(host, segments);
}

/**
 * A candidate URL read and normalized: https only, no whitespace or control
 * characters (URL parsing would silently drop a newline), no credentials,
 * the fragment dropped, stored as URL.href of at most 300 characters.
 */
function parse(raw: string): { url: string; host: string; segments: string[] } | null {
  if (raw.length > URL_MAX || !/^https:\/\//i.test(raw) || UNSAFE_IN_URL.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  parsed.hash = "";
  const url = parsed.href;
  if (url.length > DEV_LINK_URL_MAX || UNSAFE_IN_URL.test(url)) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  return { url, host: parsed.hostname.toLowerCase(), segments };
}

/** The thread dialog's prefilled instruction for a dev link: the normalized URL, secrets hidden. */
export function devLinkInstruction(link: Pick<DevLink, "url">): string {
  const safe = link.url.length > DEV_LINK_URL_MAX || UNSAFE_IN_URL.test(link.url) ? "" : link.url;
  return redactSecrets(`Look at ${safe}`).text;
}

/**
 * The dev links of a message: plain-text URLs first, then hrefs; https only,
 * de-duplicated, at most 20. Jira-style /browse/KEY-1 links count only on a
 * project remote's host or a host of another link found here.
 */
export function devLinks(text: string, hrefs: readonly string[], remotes: readonly ProjectRemote[]): DevLink[] {
  const remoteHosts = new Set(remotes.map((entry) => entry.remote.host));
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimTrailing(match[0]);
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  }
  for (const href of hrefs) {
    const url = href.trim();
    if (!seen.has(url)) {
      seen.add(url);
      candidates.push(url);
    }
  }
  const normalized = new Set<string>();
  const parsed = candidates
    .map(parse)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null && !normalized.has(entry.url) && normalized.add(entry.url) !== null);
  const isBrowse = (segments: string[]) => segments.length === 2 && segments[0] === "browse" && TRACKER_KEY.test(segments[1]!);
  const forge = parsed.map((entry) => ({
    entry,
    shape: isBrowse(entry.segments) ? null : forgeShape(entry.host, entry.segments, remoteHosts),
  }));
  const forgeHosts = new Set(forge.filter((item) => item.shape !== null).map((item) => item.entry.host));
  const links: DevLink[] = [];
  for (const { entry, shape } of forge) {
    if (links.length >= DEV_LINKS_MAX) break;
    let found = shape;
    if (found === null && isBrowse(entry.segments) && (remoteHosts.has(entry.host) || forgeHosts.has(entry.host))) {
      found = { kind: "tracker", repo: null, number: entry.segments[1]! };
    }
    if (found === null) continue;
    const repo = found.repo;
    const projectId = repo === null ? null : remotes.find((entry) => sameRepo(entry.remote, repo))?.projectId ?? null;
    links.push({ url: entry.url, kind: found.kind, repo, number: found.number, projectId });
  }
  return links;
}
