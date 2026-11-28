import { CommanderError } from "../../core/errors.ts";
import type { Capability, Endpoint, Entry, Fingerprint } from "../../core/model.ts";
import type { NameSegment, ResourcePath } from "../../core/path.ts";
import { classifyEntry, type RefusedReason } from "../../core/archive-guard.ts";
import type { FileProvider, ListPage, WriteSession } from "../../core/provider.ts";
import type { ArchiveEntry } from "../../core/wire/archive-protocol.ts";
import type { HelperResult, RequestOptions } from "./archive-helper.ts";

/** What the provider needs from the helper client. */
export interface ArchiveRpc {
  request(body: Record<string, unknown> & { t: string }, options?: RequestOptions): Promise<HelperResult>;
}

export interface ArchiveProviderOptions {
  endpoint: Endpoint;
  rpc: ArchiveRpc;
  /** Compares the archive's own file (or its source on the endpoint) with the version the plan saw. */
  verifySource(signal: AbortSignal): Promise<void>;
  /** The owner's password prompt. Absent for agents: an encrypted entry then fails with password_required. */
  password?: () => Promise<Uint8Array | null>;
}

const unsupported = () => new CommanderError("unsupported", "Archives are read-only");
const decode = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function segmentBytes(segment: NameSegment): Uint8Array {
  return "t" in segment ? new TextEncoder().encode(segment.t) : decode(segment.b);
}

function pathB64(path: ResourcePath): string {
  const parts = path.segments.map(segmentBytes);
  const total = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1);
  const joined = new Uint8Array(total);
  let at = 0;
  parts.forEach((part, index) => {
    if (index > 0) joined[at++] = 0x2f;
    joined.set(part, at);
    at += part.length;
  });
  return parts.length === 0 ? "" : encode(joined);
}

function lastSegment(raw: Uint8Array): NameSegment {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0x2f) end--;
  let start = end;
  while (start > 0 && raw[start - 1] !== 0x2f) start--;
  const name = raw.subarray(start, end);
  try {
    return { t: new TextDecoder("utf-8", { fatal: true }).decode(name) };
  } catch {
    return { b: encode(name) };
  }
}

/**
 * Why an entry cannot be extracted: the helper's own flag first, then the same guard again on the raw name
 * (second line). A password is assumed: an encrypted entry is asked about when it is read, not refused here.
 */
function refusalOf(entry: ArchiveEntry): RefusedReason | string | null {
  if (entry.refused) return entry.refused;
  if (entry.synthetic) return null;
  return classifyEntry({
    kind: entry.kind, name: decode(entry.nameB64),
    ...(entry.linkB64 === undefined ? {} : { link: decode(entry.linkB64) }), encrypted: entry.encrypted,
  }, { hasPassword: true });
}

/** Refusals that leave no name a path can address (a raw non-UTF-8 name still is addressable as bytes). */
const UNADDRESSABLE = new Set(["unsafe_name", "backslash"]);

function refusalError(reason: string): CommanderError {
  if (reason === "link_not_supported" || reason === "link_escapes") {
    return new CommanderError("unsupported", "Links in archives are not extracted", false, reason);
  }
  if (reason === "special_file") return new CommanderError("unsupported", "Special files in archives are not extracted");
  if (reason === "backslash" || reason === "name_encoding") return new CommanderError("invalid_name", "The archive entry name cannot be used");
  return new CommanderError("invalid_path", "The archive entry path is not safe");
}

function toEntry(entry: ArchiveEntry): Entry {
  const name = lastSegment(decode(entry.nameB64));
  // A refused record is never shown as a plain file or directory, so no plan can copy it by accident.
  const refused = refusalOf(entry) !== null;
  const kind: Entry["kind"] = refused ? (entry.kind === "symlink" ? "symlink" : "other")
    : entry.kind === "file" ? "file" : entry.kind === "dir" ? "dir" : entry.kind === "symlink" ? "symlink" : "other";
  let linkTarget: Entry["linkTarget"] = null;
  if (entry.linkB64 !== undefined) {
    const raw = decode(entry.linkB64);
    try {
      linkTarget = { t: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
    } catch {
      linkTarget = { b: encode(raw) };
    }
  }
  return {
    name, kind, size: entry.size,
    mtimeNs: entry.mtime === null ? null : (BigInt(Math.trunc(entry.mtime)) * 1_000_000_000n).toString(),
    mtimePrecision: entry.mtime === null ? "unknown" : "s",
    mode: entry.mode, linkTarget,
    hidden: "t" in name && name.t.startsWith("."),
  };
}

interface OpenStream {
  id: number;
  stream: number;
  pos: bigint;
  size: bigint;
  busy: boolean;
  used: number;
  idle: ReturnType<typeof setTimeout> | null;
}

const STREAM_LIMIT = 4;
const IDLE_MS = 30_000;

export class ArchiveProvider implements FileProvider {
  readonly endpoint: Endpoint;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["list", "stat", "read"]);
  /**
   * The helper keeps up to four independent read streams. A stream belongs to its reader from the first read to the
   * barrier (finishRead); it is released on an error or a cancel and after 30 idle seconds. A read that does not
   * continue a free stream (another entry, a window elsewhere, a second reader) gets a stream of its own, so nobody
   * is dropped and read again.
   */
  private readonly streams: OpenStream[] = [];
  private freed: (() => void)[] = [];

  constructor(private readonly options: ArchiveProviderOptions) {
    this.endpoint = options.endpoint;
  }

  async list(path: ResourcePath, opts: { cursor: string | null; limit: number }, signal: AbortSignal): Promise<ListPage> {
    await this.options.verifySource(signal);
    const { json } = await this.options.rpc.request(
      { t: "list", prefix: pathB64(path), cursor: opts.cursor, limit: opts.limit }, { signal },
    );
    // A record with an unusable name has no name a plan could address (stat would not find it), and showing its
    // last segment would mislead: it is left out of the listing. Links and special files stay visible, refused.
    const entries = (json.entries as ArchiveEntry[]).filter((entry) => !UNADDRESSABLE.has(String(refusalOf(entry)))).map(toEntry);
    return { entries, cursor: (json.cursor as string | null) ?? null };
  }

  async stat(path: ResourcePath, signal: AbortSignal): Promise<Entry | null> {
    const found = await this.find(path, signal);
    return found ? toEntry(found) : null;
  }

  private async find(path: ResourcePath, signal: AbortSignal): Promise<ArchiveEntry | null> {
    await this.options.verifySource(signal);
    const { json } = await this.options.rpc.request({ t: "stat", nameB64: pathB64(path) }, { signal });
    return (json.entry as ArchiveEntry | null) ?? null;
  }

  private async entryForRead(path: ResourcePath, expect: Fingerprint | null, signal: AbortSignal): Promise<ArchiveEntry> {
    const entry = await this.find(path, signal);
    if (!entry) throw new CommanderError("not_found", "Archive entry not found");
    const refusal = refusalOf(entry);
    if (refusal !== null) throw refusalError(refusal);
    if (entry.kind === "dir") throw new CommanderError("is_a_directory", "Archive entry is a directory");
    if (entry.kind !== "file") throw new CommanderError("unsupported", "Archive entry is not a regular file");
    if (expect) {
      const shown = toEntry(entry);
      if (shown.size !== expect.size || shown.mtimeNs !== expect.mtimeNs) {
        throw new CommanderError("changed_since_plan", "Archive entry changed since the plan");
      }
    }
    return entry;
  }

  private release(stream: OpenStream): void {
    stream.busy = false;
    stream.used = Date.now();
    if (stream.idle) clearTimeout(stream.idle);
    stream.idle = setTimeout(() => void this.drop(stream, new AbortController().signal), IDLE_MS);
    stream.idle.unref?.();
    for (const wake of this.freed.splice(0)) wake();
  }

  private async drop(stream: OpenStream, signal: AbortSignal): Promise<void> {
    const at = this.streams.indexOf(stream);
    if (at >= 0) this.streams.splice(at, 1);
    if (stream.idle) clearTimeout(stream.idle);
    stream.idle = null;
    await this.options.rpc.request({ t: "read_close", stream: stream.stream }, { signal }).catch(() => undefined);
    for (const wake of this.freed.splice(0)) wake();
  }

  /** A stream of the entry at exactly this position that nobody is reading, if there is one. */
  private take(id: number, pos: bigint): OpenStream | null {
    const found = this.streams.find((stream) => stream.id === id && stream.pos === pos && !stream.busy) ?? null;
    if (found) {
      found.busy = true;
      if (found.idle) clearTimeout(found.idle);
      found.idle = null;
    }
    return found;
  }

  private async openStream(entry: ArchiveEntry, signal: AbortSignal): Promise<OpenStream> {
    if (entry.id === null) throw new CommanderError("is_a_directory", "Archive entry is a directory");
    // Room: the least recently used free stream goes; when all four are being read, wait for one to be released.
    while (this.streams.length >= STREAM_LIMIT) {
      const free = this.streams.filter((stream) => !stream.busy).sort((a, b) => a.used - b.used)[0];
      if (free) {
        await this.drop(free, signal);
      } else {
        await new Promise<void>((resolve, reject) => {
          this.freed.push(resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }
    const { json } = await this.options.rpc.request(
      { t: "read_open", id: entry.id },
      { signal, ...(this.options.password ? { password: this.options.password } : {}) },
    );
    const stream: OpenStream = {
      id: entry.id, stream: json.stream as number, pos: 0n, size: BigInt(json.size as string), busy: true, used: Date.now(), idle: null,
    };
    this.streams.push(stream);
    return stream;
  }

  /** Runs the action on a stream; an error or a cancel releases (closes) it, success keeps it for its reader. */
  private async using<T>(stream: OpenStream, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    try {
      const result = await action();
      this.release(stream);
      return result;
    } catch (error) {
      await this.drop(stream, new AbortController().signal);
      throw error;
    }
  }

  async read(path: ResourcePath, offset: bigint, length: number, expect: Fingerprint | null, signal: AbortSignal): Promise<Uint8Array> {
    const entry = await this.entryForRead(path, expect, signal);
    const size = BigInt(entry.size);
    if (offset >= size) return new Uint8Array(0);
    const id = entry.id!;
    let stream = this.take(id, offset);
    if (!stream) {
      stream = await this.openStream(entry, signal);
      const fresh = stream;
      await this.using(fresh, signal, async () => {
        while (fresh.pos < offset) {
          const skip = Number(offset - fresh.pos < 4_194_304n ? offset - fresh.pos : 4_194_304n);
          await this.pull(fresh, skip, signal);
        }
      }).catch((error: unknown) => { throw error; });
      stream = this.take(id, offset) ?? fresh;
      stream.busy = true;
    }
    const live = stream;
    return this.using(live, signal, () => this.pull(live, Math.min(length, Number(size - live.pos)), signal));
  }

  private async pull(stream: OpenStream, length: number, signal: AbortSignal): Promise<Uint8Array> {
    const { data } = await this.options.rpc.request({ t: "read", stream: stream.stream, length }, { signal });
    const total = data.reduce((n, d) => n + d.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of data) {
      out.set(chunk, at);
      at += chunk.length;
    }
    stream.pos += BigInt(total);
    return out;
  }

  /**
   * Integrity barrier: the entry's size and checksum are confirmed by the helper before anything is committed.
   * When another reader moved the entry's stream since the copy last read it, the barrier does not guess: it reads
   * the entry through on a stream of its own and confirms that.
   */
  async finishRead(path: ResourcePath, expect: Fingerprint | null, signal: AbortSignal): Promise<void> {
    const entry = await this.entryForRead(path, expect, signal);
    const size = BigInt(entry.size);
    const id = entry.id!;
    // The reader's own stream, if it was read to the end; otherwise the entry is read through on a stream of its own.
    let stream = this.take(id, size);
    if (!stream) {
      stream = await this.openStream(entry, signal);
      const fresh = stream;
      await this.using(fresh, signal, async () => {
        while (fresh.pos < size) {
          await this.pull(fresh, Number(size - fresh.pos < 4_194_304n ? size - fresh.pos : 4_194_304n), signal);
        }
      });
      stream = this.take(id, size) ?? fresh;
      stream.busy = true;
    }
    const done = stream;
    try {
      await this.options.rpc.request({ t: "read_finish", stream: done.stream }, { signal });
    } finally {
      await this.drop(done, signal);
    }
  }

  readonly copyWithin = undefined;
  readonly sha256 = undefined;

  openWrite(...args: Parameters<FileProvider["openWrite"]>): Promise<WriteSession> {
    void args;
    return Promise.reject(unsupported());
  }
  mkdir(...args: Parameters<FileProvider["mkdir"]>): Promise<void> {
    void args;
    return Promise.reject(unsupported());
  }
  rename(...args: Parameters<FileProvider["rename"]>): Promise<void> {
    void args;
    return Promise.reject(unsupported());
  }
  remove(...args: Parameters<FileProvider["remove"]>): Promise<void> {
    void args;
    return Promise.reject(unsupported());
  }
}
