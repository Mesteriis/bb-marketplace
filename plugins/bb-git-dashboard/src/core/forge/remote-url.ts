export type RemoteRef = {transport: "https" | "ssh"; host: string; port: number | null; path: string};

const hostName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const user = /^[A-Za-z0-9._-]{1,64}$/;

function cleanPath(raw: string) {
  const parts = raw.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === ".." || /[\s\\]/.test(part))) return null;
  return parts.join("/");
}

function ref(transport: RemoteRef["transport"], host: string, port: number | null, rawPath: string): RemoteRef | null {
  const path = cleanPath(rawPath);
  if (!hostName.test(host) || !path) return null;
  return {transport, host: host.toLowerCase(), port, path};
}

/** Parses an origin URL into forge coordinates. Remotes carrying credentials or pointing at local paths are rejected. */
export function parseRemote(value: string): RemoteRef | null {
  const input = value.trim();
  if (!input || input.length > 1000 || /[\r\n]/.test(input)) return null;
  if (input.includes("://")) {
    let url: URL;
    try { url = new URL(input); } catch { return null; }
    if (url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url.username ? null : ref("https", url.hostname, url.port ? Number(url.port) : null, url.pathname);
    if (url.protocol === "ssh:") {
      if (url.username && !user.test(url.username)) return null;
      return ref("ssh", url.hostname, url.port ? Number(url.port) : null, url.pathname);
    }
    return null;
  }
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(input);
  if (!scp || (scp[1] && !user.test(scp[1])) || scp[3].startsWith("/")) return null;
  return ref("ssh", scp[2], null, scp[3]);
}

export function sameRepository(left: RemoteRef, right: RemoteRef) {
  return left.host === right.host && left.path.toLowerCase() === right.path.toLowerCase();
}

type Kind = "github" | "gitlab" | "gitea" | "azure";

function decoded(parts: string[]) {
  try { return parts.map(part => decodeURIComponent(part)); } catch { return null; }
}

/** The provider's own repository path for a remote: `owner/name`, a GitLab group path, or `project/name` on Azure. */
export function providerPath(kind: Kind, remote: RemoteRef): string | null {
  const parts = decoded(remote.path.split("/"));
  if (!parts) return null;
  if (kind === "gitlab") return parts.join("/");
  if (kind === "github" || kind === "gitea") return parts.length === 2 ? parts.join("/") : null;
  const git = parts.indexOf("_git");
  if (git >= 1 && git === parts.length - 2) return parts[git - 1] + "/" + parts[git + 1];
  if (parts[0] === "v3" && parts.length === 4) return parts[2] + "/" + parts[3];
  return null;
}

/** The Azure DevOps organization a remote belongs to, lower-cased; null for other servers. */
export function azureOrganization(remote: RemoteRef): string | null {
  const parts = remote.path.split("/");
  const named = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(remote.host);
  if (named) return named[1];
  if (remote.host === "dev.azure.com") return parts[0]?.toLowerCase() ?? null;
  if (remote.host === "ssh.dev.azure.com" && parts[0] === "v3") return parts[1]?.toLowerCase() ?? null;
  return null;
}
