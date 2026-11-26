// Git remote URLs reduced to a forge key ("host/owner/name", lower case), so a
// local clone and a forge listing of the same repository meet.

/** "host/path" for a forge remote, or null for local paths and file URLs. */
export function remoteKey(url: string): string | null {
  const u = url.trim();
  let host: string;
  let path: string;
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(u);
    if (m === null) return null;
    host = m[1]!;
    path = m[2]!;
  }
  const clean = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!clean.includes("/")) return null;
  return `${host}/${clean}`.toLowerCase();
}

/** Every `url` inside a `[remote "…"]` section of a git config file. */
export function parseGitConfigRemotes(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[remote\s+"[^"]*"\]$/.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m !== null) urls.push(m[1]!.trim());
  }
  return urls;
}

/** The target of a `.git` file ("gitdir: <path>"), as worktrees and submodules write it. */
export function parseGitdirPointer(text: string): string | null {
  const m = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(text);
  return m === null ? null : m[1]!;
}
