import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { treeFileOf, type TreeFile } from "../../core/scaffolds/source.ts";
import { CodedError } from "../../core/workspace.ts";

/** Limits of a templates folder: a file as the scaffold model takes it, the whole tree, how deep. */
export const treeLimits = {file: 256 * 1024, total: 20 * 1024 * 1024, files: 2000, depth: 12};
const refuse = (detail: string) => new CodedError("SCAFFOLDS_INVALID", detail);

/** Text when the bytes are UTF-8 without NUL; otherwise the bytes in base64 (an icon). */
export const treeFile = (path: string, bytes: Buffer, executable: boolean): TreeFile => treeFileOf(path, bytes, executable);

/**
 * The files of a templates folder in the layout of the templates repository — `common/` and `templates/<id>/` only,
 * `.git` and everything else left out — as repository paths. A link, a file over 256 KB, more than 2000 files, more
 * than 20 MB or a path deeper than 12 refuse the folder with the reason; nothing is followed out of it.
 */
export async function readScaffoldTree(folder: string): Promise<{files: TreeFile[]}> {
  if (!isAbsolute(folder) || /[\r\n\0]/.test(folder)) throw new CodedError("INVALID_PATH", "the templates folder must be an absolute path");
  const files: TreeFile[] = [];
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > treeLimits.depth) throw refuse(relative + " is deeper than " + treeLimits.depth);
    const names = (await readdir(join(folder, relative))).sort();
    for (const name of names) {
      if (name === ".git") continue;
      const path = relative ? relative + "/" + name : name;
      const entry = await lstat(join(folder, path));
      if (entry.isSymbolicLink()) throw refuse(path + " is a link");
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) throw refuse(path + " is not a file");
      if (entry.size > treeLimits.file) throw refuse(path + " is over 256 KB");
      total += entry.size;
      if (files.length >= treeLimits.files) throw refuse("more than " + treeLimits.files + " files");
      if (total > treeLimits.total) throw refuse("over 20 MB in all");
      files.push(treeFile(path, await readFile(join(folder, path)), (entry.mode & 0o111) !== 0));
    }
  };
  for (const top of ["common", "templates"]) {
    const entry = await lstat(join(folder, top)).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw refuse(top + " is not a folder");
    await walk(top, 1);
  }
  return {files};
}
