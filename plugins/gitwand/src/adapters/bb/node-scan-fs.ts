// The scan's file system on Node: folders without following symlinks, small
// text files (git config, gitdir and commondir pointers) only.
import { readdir, readFile, stat } from "node:fs/promises";
import type { ScanFs } from "../../core/repo-scan.ts";

const MAX_TEXT_BYTES = 1 << 20;

export const nodeScanFs: ScanFs = {
  async list(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" }));
  },
  async read(path) {
    try {
      if ((await stat(path)).size > MAX_TEXT_BYTES) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
};
