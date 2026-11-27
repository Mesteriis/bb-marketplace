import { CommanderError } from "./errors.ts";
import type { Entry } from "./model.ts";
import { join, type NameSegment, type ResourcePath } from "./path.ts";
import { LIST_PAGE_MAX, READ_CHUNK_MAX, type FileProvider } from "./provider.ts";
import { matches, readChunks, TransferHash, type Location } from "./reconcile.ts";
import { toBig } from "./size.ts";

export type FileCompareMode = "size" | "sha256" | "bytes";
export interface DirCompareOptions {
  by: "size+mtime" | "sha256";
  mtimeToleranceMs: number;
  limit: number;
}

export interface DirDiff {
  onlyLeft: Entry[];
  onlyRight: Entry[];
  differ: [Entry, Entry][];
  same: number;
  partial: boolean;
}

interface ReadOptions {
  onBytes?(bytes: bigint): void;
  createHash?(): Pick<TransferHash, "update" | "finish">;
}

export function estimateRead(entries: readonly Entry[]): bigint {
  return entries.reduce((size, entry) => entry.kind === "file" ? size + toBig(entry.size) : size, 0n);
}

export async function scanFile({ provider, path }: Location, signal: AbortSignal): Promise<Entry> {
  signal.throwIfAborted();
  const entry = await provider.stat(path, signal);
  signal.throwIfAborted();
  if (!entry) throw new CommanderError("not_found", "File not found");
  if (entry.kind !== "file") throw new CommanderError("unsupported", "Expected a regular file");
  return entry;
}

async function verifyFile(location: Location, expected: Entry, signal: AbortSignal): Promise<void> {
  const actual = await scanFile(location, signal);
  if (!matches(actual, expected)) throw new CommanderError("changed_since_plan", "File changed during scan");
}

async function hashFile(location: Location, expected: Entry, signal: AbortSignal, opts: ReadOptions) {
  const { provider, path } = location;
  signal.throwIfAborted();
  if (provider.sha256) {
    await verifyFile(location, expected, signal);
    const hex = await provider.sha256(path, signal);
    await verifyFile(location, expected, signal);
    opts.onBytes?.(toBig(expected.size));
    return hex;
  }
  const hash = opts.createHash?.() ?? new TransferHash();
  await readChunks(location, expected, READ_CHUNK_MAX, signal, async (call) => {
    signal.throwIfAborted();
    const value = await call();
    signal.throwIfAborted();
    return value;
  }, async (chunk) => {
    hash.update(chunk);
    opts.onBytes?.(BigInt(chunk.length));
  });
  await verifyFile(location, expected, signal);
  return hash.finish();
}

export async function checksum(provider: FileProvider, path: ResourcePath, signal: AbortSignal,
  opts: ReadOptions & { expected?: Entry } = {}): Promise<string> {
  const location = { provider, path };
  return hashFile(location, opts.expected ?? await scanFile(location, signal), signal, opts);
}

export async function compareFiles(a: Location, b: Location, mode: FileCompareMode, signal: AbortSignal,
  opts: ReadOptions & { expected?: [Entry, Entry] } = {}): Promise<"same" | "different"> {
  const [left, right] = opts.expected ?? [await scanFile(a, signal), await scanFile(b, signal)];
  signal.throwIfAborted();
  if (left.size !== right.size) return "different";
  if (mode === "size") return "same";
  if (mode === "sha256") {
    const leftHash = await hashFile(a, left, signal, opts);
    return leftHash === await hashFile(b, right, signal, opts) ? "same" : "different";
  }

  async function read(location: Location, entry: Entry, offset: bigint, length: number) {
    signal.throwIfAborted();
    const { size, mtimeNs } = entry;
    const bytes = await location.provider.read(location.path, offset, length, { size, mtimeNs }, signal);
    signal.throwIfAborted();
    if (!bytes.length || bytes.length > length) throw new CommanderError("changed_since_plan", "Unexpected source length");
    opts.onBytes?.(BigInt(bytes.length));
    return bytes;
  }

  const size = toBig(left.size);
  for (let offset = 0n; offset < size;) {
    const chunk = await read(a, left, offset, Math.min(READ_CHUNK_MAX, Number(size - offset)));
    for (let index = 0; index < chunk.length;) {
      const other = await read(b, right, offset + BigInt(index), chunk.length - index);
      for (const byte of other) if (chunk[index++] !== byte) return "different";
    }
    offset += BigInt(chunk.length);
  }
  await verifyFile(a, left, signal);
  await verifyFile(b, right, signal);
  return "same";
}

interface DirListing {
  entries: Entry[];
  partial: boolean;
}

export async function scanDir({ provider, path }: Location, limit: number, signal: AbortSignal): Promise<DirListing> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid directory scan limit");
  const entries: Entry[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    signal.throwIfAborted();
    const count = Math.min(limit - entries.length, LIST_PAGE_MAX);
    const page = await provider.list(path, { cursor, limit: count }, signal);
    signal.throwIfAborted();
    if (page.entries.length > count || (page.cursor !== null && seen.has(page.cursor))) {
      throw new CommanderError("internal", "Invalid directory page");
    }
    entries.push(...page.entries);
    cursor = page.cursor;
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null && entries.length < limit && seen.size <= limit);
  return { entries, partial: cursor !== null };
}

function nameKey(name: NameSegment, caseSensitive: boolean) {
  return "b" in name ? "b:" + atob(name.b) : "t:" + (caseSensitive ? name.t : name.t.normalize("NFC").toLowerCase());
}

function withinTolerance(a: Entry, b: Entry, toleranceMs: number) {
  if (a.mtimeNs === null || b.mtimeNs === null) return false;
  const delta = BigInt(a.mtimeNs) - BigInt(b.mtimeNs);
  const max = BigInt(toleranceMs) * 1_000_000n;
  return delta >= -max && delta <= max;
}

/** Compares the immediate children of each directory. */
export async function compareDirs(a: Location, b: Location, opts: DirCompareOptions, signal: AbortSignal,
  read: ReadOptions & { listings?: [DirListing, DirListing]; onItem?(): void } = {}): Promise<DirDiff> {
  const [left, right] = read.listings ?? [await scanDir(a, opts.limit, signal), await scanDir(b, opts.limit, signal)];
  const result: DirDiff = { onlyLeft: [], onlyRight: [], differ: [], same: 0, partial: left.partial || right.partial };
  const caseSensitive = a.provider.endpoint.caseSensitive || b.provider.endpoint.caseSensitive;
  const key = (entry: Entry) => nameKey(entry.name, caseSensitive);
  const remaining = new Map(right.entries.map((entry) => [key(entry), entry]));
  for (const entry of left.entries) {
    signal.throwIfAborted();
    const other = remaining.get(key(entry));
    if (!other) {
      if (!right.partial) result.onlyLeft.push(entry);
    } else {
      remaining.delete(key(entry));
      let same = false;
      if (entry.kind === other.kind) {
        if (entry.kind === "dir") same = true;
        else if (entry.kind === "file" && entry.size === other.size) {
          if (opts.by === "size+mtime") same = withinTolerance(entry, other, opts.mtimeToleranceMs);
          else {
            same = await compareFiles({ provider: a.provider, path: join(a.path, entry.name) },
              { provider: b.provider, path: join(b.path, other.name) }, "sha256", signal,
              { ...read, expected: [entry, other] }) === "same";
          }
        }
      }
      if (same) result.same++;
      else result.differ.push([entry, other]);
    }
    read.onItem?.();
  }
  signal.throwIfAborted();
  for (const entry of remaining.values()) {
    if (!left.partial) result.onlyRight.push(entry);
    read.onItem?.();
  }
  return result;
}
