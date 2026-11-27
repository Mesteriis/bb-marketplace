import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { win32 } from "node:path";
import { CommanderError } from "../../../core/errors.ts";
import { type NameSegment, ResourcePath } from "../../../core/path.ts";
import { hasErrno } from "./errors.ts";
import { validateTargetName, type NamePlatform } from "./names.ts";

export type FsPath = Buffer | string;
const slash = Buffer.from("/");

export function encodeName(name: NameSegment): Buffer {
  return "t" in name ? Buffer.from(name.t) : Buffer.from(name.b, "base64");
}

export function decodeName(bytes: Buffer): NameSegment {
  const t = bytes.toString("utf8");
  return bytes.equals(Buffer.from(t)) ? { t } : { b: bytes.toString("base64") };
}

export function childPath(parent: FsPath, name: NameSegment): FsPath {
  if (typeof parent === "string") {
    if (!("t" in name) || /[\\/:]/u.test(name.t)) {
      throw new CommanderError("invalid_path", "Invalid Windows path component");
    }
    return parent.endsWith("\\") ? parent + name.t : parent + "\\" + name.t;
  }
  return Buffer.concat(parent.equals(slash) ? [slash, encodeName(name)] : [parent, slash, encodeName(name)]);
}

export async function lstatOrNull(path: FsPath): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasErrno(error, "ENOENT")) return null;
    throw error;
  }
}

export function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function stagingNameConflicts(parent: FsPath, target: NameSegment, temp: NameSegment): Promise<boolean> {
  if (encodeName(target).equals(encodeName(temp))) return true;
  if (!("t" in target) || !("t" in temp)) return false;
  const targetText = process.platform === "darwin" ? target.t.normalize("NFC") : target.t;
  const tempText = process.platform === "darwin" ? temp.t.normalize("NFC") : temp.t;
  if (targetText === tempText) return true;
  if (targetText.toUpperCase() !== tempText.toUpperCase()) return false;
  return !await directoryShowsCaseSensitivity(parent);
}

/** Use a read-only lookup in the actual directory. Empty, unreadable and inconclusive directories fail closed. */
async function directoryShowsCaseSensitivity(path: FsPath): Promise<boolean> {
  try {
    // Node supports Buffer names at runtime even though opendir's types omit the encoding.
    const directory = await opendir(path, { encoding: "buffer" as BufferEncoding });
    try {
      for (let index = 0; index < 32; index++) {
        const entry = await directory.read();
        if (!entry) return false;
        const name = decodeName(Buffer.from(entry.name));
        if (!("t" in name)) continue;
        const alternate = name.t.replace(/[A-Za-z]/u, (letter) =>
          letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
        if (alternate === name.t) continue;
        const originalPath = childPath(path, name);
        const original = await lstatOrNull(originalPath);
        if (!original) continue;
        const alias = await lstatOrNull(childPath(path, { t: alternate }));
        const current = await lstatOrNull(originalPath);
        if (current && sameNode(original, current)) return !alias || !sameNode(original, alias);
      }
      return false;
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (hasErrno(error, "EACCES") || hasErrno(error, "EPERM")) return false;
    throw error;
  }
}

export function requireDirectory(stats: BigIntStats): void {
  if (stats.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link in directory path");
  if (!stats.isDirectory()) throw new CommanderError("not_a_directory", "Expected a directory");
}

export function parseWindowsPath(absolute: string): ResourcePath {
  if (/^[/\\]{2}/u.test(absolute)) throw new CommanderError("unsupported", "UNC paths are not supported");
  const drive = /^([a-z]:)[/\\]/iu.exec(absolute);
  if (!drive) throw new CommanderError("invalid_path", "An absolute Windows drive path is required");
  const names = absolute.slice(drive[0].length).split(/[/\\]/u).filter(Boolean);
  const path = ResourcePath.safeParse({ segments: [drive[1]!, ...names].map((t) => ({ t })) });
  if (!path.success) throw new CommanderError("invalid_path", "Invalid Windows drive path");
  return path.data;
}

export async function resolvePath(path: ResourcePath, platform: NamePlatform, opts: {
  target?: boolean;
  mutable?: boolean;
} = {}) {
  const segments = path.segments;
  const drive = segments[0];
  if (opts.target && segments.length > 0) validateTargetName(segments[segments.length - 1]!, platform);
  let full: FsPath = slash;
  let start = 0;
  if (platform === "win32") {
    if (!drive || !("t" in drive) || !/^[a-z]:$/iu.test(drive.t)) {
      throw new CommanderError("invalid_path", "A Windows drive is required");
    }
    // The namespace prefix preserves existing names that Win32 would normalize.
    full = win32.toNamespacedPath(drive.t + "\\");
    start = 1;
  }
  if (segments.length === start) {
    if (opts.mutable || opts.target) throw new CommanderError("permission_denied", "Cannot modify a filesystem root");
    return { full, parent: null, parentStats: null, stats: await lstatOrNull(full) };
  }
  let parentStats = await lstat(full, { bigint: true });
  requireDirectory(parentStats);
  for (const name of segments.slice(start, -1)) {
    full = childPath(full, name);
    parentStats = await lstat(full, { bigint: true });
    requireDirectory(parentStats);
  }
  const parent = full;
  full = childPath(parent, segments[segments.length - 1]!);
  const stats = await lstatOrNull(full);
  if (opts.target && stats?.isSymbolicLink()) {
    throw new CommanderError("permission_denied", "Symbolic link at target");
  }
  return { full, parent, parentStats, stats };
}

export async function recheckParent({ parent, parentStats }: Awaited<ReturnType<typeof resolvePath>>): Promise<void> {
  if (!parent || !parentStats) throw new CommanderError("permission_denied", "Cannot modify a filesystem root");
  const current = await lstatOrNull(parent);
  if (current?.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link in directory path");
  if (!current || !current.isDirectory() || !sameNode(current, parentStats)) {
    throw new CommanderError("changed_since_plan", "Parent directory changed");
  }
}

export async function requireAbsent(path: FsPath, plannedAbsent = false): Promise<void> {
  const stats = await lstatOrNull(path);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new CommanderError("permission_denied", "Symbolic link at target");
  if (plannedAbsent) throw new CommanderError("changed_since_plan", "Target appeared since planning");
  throw new CommanderError("already_exists", "Target exists");
}
