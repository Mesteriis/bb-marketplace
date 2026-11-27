import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { filePath } from "./local-git.ts";

/** The largest file a suggestion is applied to. */
const fileMaxBytes = 1024 * 1024;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** A regular text file inside the copy, read whole; links, folders, binaries and large files are refused. */
export async function readReviewFile(root: string, path: string) {
  const relative = await filePath(root, path);
  const full = join(root, relative);
  const info = await lstat(full).catch(() => { throw new Error("NOT_FOUND"); });
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("INVALID_PATH");
  if (info.size > fileMaxBytes) throw new Error("FILE_TOO_LARGE");
  const bytes = await readFile(full);
  if (bytes.includes(0)) throw new Error("BINARY_FILE");
  // Written back as UTF-8, any other encoding would lose every byte that is not valid UTF-8.
  let text: string;
  try { text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error("NOT_UTF8"); }
  return {text, sha256: digest(bytes)};
}

/**
 * Replaces a file's text when it still reads what the change was computed from (`expected`, the hash of its bytes);
 * otherwise CHANGED and nothing is written. The new text goes to a temporary file beside it, then over it, with the
 * old file's mode.
 */
export async function writeReviewFile(root: string, path: string, expected: string, text: string) {
  const current = await readReviewFile(root, path);
  if (current.sha256 !== expected) throw new Error("CHANGED");
  const full = join(root, path);
  const temporary = join(dirname(full), "." + randomBytes(6).toString("hex") + ".makosh-git");
  try {
    await writeFile(temporary, text, {mode: (await stat(full)).mode & 0o777, flag: "wx"});
    // The folder may have been swapped for a link since the path was checked: write only where it was.
    if (await realpath(dirname(full)) !== dirname(full)) throw new Error("INVALID_PATH");
    await rename(temporary, full);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
  return {sha256: digest(text)};
}
