import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, join as nodeJoin, win32 } from "node:path";
import { CommanderError } from "../../core/errors.ts";
import type { ResourcePath } from "../../core/path.ts";
import { EDIT_DIRECTORY } from "./edit-files.ts";
import type { NamePlatform } from "./host-fs/names.ts";
import { childPath, lstatOrNull, sameNode, type FsPath } from "./host-fs/paths.ts";

type PathPolicy = {
  check(path: ResourcePath, forbidAncestor?: boolean): Promise<void>;
  hidden(path: FsPath, stats?: BigIntStats | null): Promise<boolean>;
};

function denied() {
  return new CommanderError("permission_denied", "Path is outside the agent's grant");
}

async function followed(path: FsPath) {
  return stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") return null;
    throw error;
  });
}

function canonicalParent(path: FsPath): FsPath {
  if (typeof path === "string") return win32.dirname(path);
  const slash = path.lastIndexOf(47);
  return path.subarray(0, Math.max(1, slash));
}

async function canonical(path: FsPath): Promise<FsPath | null> {
  try {
    return typeof path === "string" ? await realpath(path) : await realpath(path, { encoding: "buffer" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return null;
    throw error;
  }
}

export async function createEditPathPolicy(dataDir: string, platform: NamePlatform, signal: AbortSignal): Promise<PathPolicy> {
  const data = await followed(dataDir);
  const privateDir = await followed(nodeJoin(dataDir, EDIT_DIRECTORY));

  async function hidden(path: FsPath, info?: BigIntStats | null): Promise<boolean> {
    signal.throwIfAborted();
    const parent = canonicalParent(path);
    const leaf = typeof path === "string" ? win32.basename(path) : path.subarray(path.lastIndexOf(47) + 1).toString("utf8");
    if (data && leaf.toLowerCase() === EDIT_DIRECTORY) {
      const parentInfo = await followed(parent);
      if (parentInfo && sameNode(parentInfo, data)) return true;
    }
    if (!privateDir) return false;
    const metadata = info === undefined ? await lstatOrNull(path) : info;
    if (!metadata) return false;
    if (sameNode(metadata, privateDir)) return true;
    if (!metadata.isSymbolicLink()) return false;
    for (let full = await canonical(path); full !== null;) {
      const version = await followed(full);
      if (version && sameNode(version, privateDir)) return true;
      const parent = canonicalParent(full);
      if (String(parent) === String(full)) break;
      full = parent;
    }
    return false;
  }

  return {
    hidden,
    async check(path, forbidAncestor = false) {
      const [drive, ...rest] = path.segments;
      let full: FsPath = Buffer.from("/");
      let metadata: BigIntStats | null = null;
      let names = path.segments;
      if (platform === "win32") {
        if (!drive || !("t" in drive) || !/^[a-z]:$/iu.test(drive.t)) return;
        full = win32.toNamespacedPath(drive.t + "\\");
        names = rest;
      }
      for (const name of names) {
        full = childPath(full, name);
        metadata = await lstatOrNull(full);
        if (await hidden(full, metadata)) throw denied();
      }
      if (forbidAncestor && metadata) {
        for (let current = await realpath(dataDir).catch(() => dataDir);;) {
          const ancestor = await followed(current);
          if (ancestor && sameNode(metadata, ancestor)) throw denied();
          const parent = dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    },
  };
}
