import { CodedError } from "../workspace.ts";
import { treeFileOf, type TreeFile } from "./source.ts";

/**
 * The limits of a templates repository's archive: compressed and unpacked size, entries, path depth below the
 * archive's top folder, and one file (as a templates folder's).
 */
export const archiveLimits = {compressed: 5 * 1024 * 1024, unpacked: 20 * 1024 * 1024, entries: 2000, depth: 12, file: 256 * 1024};
const refuse = (detail: string) => new CodedError("SCAFFOLDS_INVALID", detail);
const decoder = new TextDecoder("utf-8", {fatal: true});

/** A field of a tar header: text up to its first NUL. */
function field(block: Uint8Array, at: number, length: number) {
  const bytes = block.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(block: Uint8Array, at: number, length: number) {
  const text = field(block, at, length).trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw refuse("the archive is not a tar archive");
  return parseInt(text, 8);
}
/** The header's checksum: the sum of its bytes with the checksum field read as spaces. */
function checksumFits(block: Uint8Array) {
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  return sum === octal(block, 148, 8);
}
/** The values of a pax extended header ("<length> <key>=<value>\n" records). */
function paxValues(bytes: Uint8Array) {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const length = space < 0 ? NaN : Number(new TextDecoder().decode(bytes.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0 || offset + length > bytes.length) throw refuse("the archive is not a tar archive");
    const record = decoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) values.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return values;
}

/**
 * The files of a templates repository's tar archive (as GitHub's tarball of a commit: one top folder, pax headers),
 * read in memory, nothing written anywhere. Each entry's name and type are checked before its content is taken:
 * a link, a device, an absolute path, `..` or a path outside the one top folder refuses the whole archive, as do the
 * limits. Only `common/` and `templates/` are kept, as repository paths; folders are not entries of the result.
 */
export function readTarball(tar: Uint8Array): TreeFile[] {
  const files: TreeFile[] = [];
  let offset = 0;
  let entries = 0;
  let unpacked = 0;
  let root: string | null = null;
  let pax = new Map<string, string>();
  for (;;) {
    if (offset + 512 > tar.length) throw refuse("the archive ends inside an entry");
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    if (!checksumFits(block)) throw refuse("the archive is not a tar archive");
    const type = field(block, 156, 1) || "0";
    const size = octal(block, 124, 12);
    const start = offset + 512;
    const end = start + Math.ceil(size / 512) * 512;
    if (start + size > tar.length) throw refuse("the archive ends inside an entry");
    offset = end;
    // Extended headers describe the next entry (x) or the archive (g, GitHub's commit comment).
    if (type === "g") continue;
    if (type === "x") { pax = paxValues(tar.subarray(start, start + size)); continue; }
    const prefix = field(block, 345, 155);
    const name = pax.get("path") ?? (prefix ? prefix + "/" : "") + field(block, 0, 100);
    pax = new Map();
    if (++entries > archiveLimits.entries) throw refuse("more than " + archiveLimits.entries + " entries");
    const segments = name.split("/").filter(Boolean);
    if (root === null && !name.startsWith("/") && segments.length) root = segments[0]!;
    const shown = (root && name.startsWith(root + "/") ? name.slice(root.length + 1) : name).replace(/\/$/, "");
    if (name.startsWith("/") || segments.includes("..") || segments.includes(".") || /[\\\0]/.test(name) || !segments.length) throw refuse(shown + " is not inside the archive's folder");
    if (segments[0] !== root) throw refuse(shown + " is not inside the archive's folder");
    const path = segments.slice(1).join("/");
    if (segments.length - 1 > archiveLimits.depth) throw refuse(path + " is deeper than " + archiveLimits.depth);
    if (type === "1" || type === "2") throw refuse(path + " is a link");
    if (type === "5") continue;
    if (type !== "0" && type !== "7") throw refuse(path + " is not a file or a folder");
    unpacked += size;
    if (unpacked > archiveLimits.unpacked) throw refuse("over 20 MB unpacked");
    if (!/^(?:common|templates)\//.test(path)) continue;
    if (size > archiveLimits.file) throw refuse(path + " is over 256 KB");
    files.push(treeFileOf(path, tar.subarray(start, start + size), (octal(block, 100, 8) & 0o111) !== 0));
  }
  return files;
}
