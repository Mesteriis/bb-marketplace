// A path as the interface shows it: from ~ under a user's home folder (macOS /Users/<name>, Linux /home/<name>). No I/O.

/** `/Users/<name>/…` and `/home/<name>/…` from `~`; macOS's shared folder and every other path stay whole. */
export function homeRelative(path: string): string {
  const match = /^\/(?:Users|home)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match || match[1] === "Shared") return path;
  return "~" + (match[2] ?? "");
}
