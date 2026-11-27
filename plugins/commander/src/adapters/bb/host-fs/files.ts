import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, readlink, type FileHandle } from "node:fs/promises";
import { CommanderError } from "../../../core/errors.ts";
import { type Entry, type EntryKind, type Fingerprint } from "../../../core/model.ts";
import { type NameSegment } from "../../../core/path.ts";
import { READ_CHUNK_MAX } from "../../../core/provider.ts";
import { fromBig, toBig, type Size } from "../../../core/size.ts";
import { decodeName, encodeName, sameNode, type FsPath } from "./paths.ts";

export function entryKind(stats: BigIntStats): EntryKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "dir";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

export function fingerprint(stats: BigIntStats): Fingerprint {
  return { size: fromBig(stats.size), mtimeNs: stats.mtimeNs.toString() };
}

export async function describe(path: FsPath, name: NameSegment, stats: BigIntStats): Promise<Entry> {
  return {
    name,
    kind: entryKind(stats),
    ...fingerprint(stats),
    mtimePrecision: process.platform === "win32" ? "ms" : "ns",
    mode: process.platform === "win32" ? null : Number(stats.mode),
    linkTarget: stats.isSymbolicLink() ? decodeName(await readlink(path, { encoding: "buffer" })) : null,
    hidden: encodeName(name)[0] === 46,
  };
}

export function changed(): CommanderError {
  return new CommanderError("changed_since_plan", "Filesystem entry changed since planning");
}

export function matches(stats: BigIntStats, expect: Fingerprint): boolean {
  const actual = fingerprint(stats);
  return actual.size === expect.size && actual.mtimeNs === expect.mtimeNs;
}

export function position(offset: Size): number {
  const n = toBig(offset);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CommanderError("limit_exceeded", "File offset is outside the supported range");
  }
  // Node's FileHandle.write accepts numeric positions; bigint can silently write at the cursor.
  return Number(n);
}

export async function withRegularFile<T>(
  path: FsPath, stats: BigIntStats | null, signal: AbortSignal,
  use: (file: FileHandle, opened: BigIntStats) => Promise<T>,
): Promise<T> {
  if (!stats) throw new CommanderError("not_found", "Source does not exist");
  if (stats.isDirectory()) throw new CommanderError("is_a_directory", "Expected a regular file");
  if (!stats.isFile()) throw new CommanderError("unsupported", "Only regular files can be read");
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || !sameNode(stats, opened)) throw changed();
    signal.throwIfAborted();
    return await use(file, opened);
  } finally {
    await file.close();
  }
}

export async function forEachChunk(
  file: FileHandle, signal: AbortSignal, consume: (chunk: Buffer, offset: number) => void | Promise<void>,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_MAX);
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) return;
    await consume(buffer.subarray(0, bytesRead), offset);
    offset += bytesRead;
  }
}

export async function hashFile(file: FileHandle, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await forEachChunk(file, signal, (chunk) => { hash.update(chunk); });
  return hash.digest("hex");
}
