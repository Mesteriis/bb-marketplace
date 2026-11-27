import { CommanderError } from "../errors.ts";
import type { Capability, Endpoint, Entry, Fingerprint } from "../model.ts";
import { isAncestorOrSelf, join, parent, samePath, type ResourcePath } from "../path.ts";
import { READ_CHUNK_MAX, type FileProvider, type WriteSession } from "../provider.ts";
import { TransferHash } from "../reconcile.ts";

const relayBuffers = new WeakMap<Uint8Array, () => void>();

type Op = keyof Omit<FileProvider, "endpoint" | "capabilities"> | "write" | "commit" | "abort";
interface StoredEntry {
  path: ResourcePath;
  kind: Entry["kind"];
  bytes: Uint8Array;
  mtimeNs: string;
  temporary?: boolean;
  size?: number;
}

export class FakeProvider implements FileProvider {
  readonly endpoint: Endpoint;
  private readonly flags = new Set<Capability>(["list", "stat", "read", "write", "mkdir", "rename", "remove", "atomicReplace", "seek"]);
  readonly capabilities: ReadonlySet<Capability> = this.flags;
  readonly failOn: { op: Op; path: ResourcePath; times: number; error: CommanderError }[] = [];
  readonly calls: { op: Op; path: ResourcePath }[] = [];
  delay?: (op: Op, path: ResourcePath, signal: AbortSignal) => Promise<void>;
  trackRelayReads = false;
  /** Hide the last N written bytes from stat of an open temp, like a buffered SFTP handle. */
  tempStatLag = 0;
  peakReadBytes = 0;
  private liveReadBytes = 0;
  private clock = 100;
  private readonly entries = new Set<StoredEntry>();
  /** The endpoint root always exists as a directory; no operation may replace or remove it. */
  private readonly root: StoredEntry = { path: { segments: [] }, kind: "dir", bytes: new Uint8Array(), mtimeNs: "1" };
  copyWithin?: FileProvider["copyWithin"];
  sha256?: FileProvider["sha256"];

  constructor(id: string, caseSensitive = true) {
    this.endpoint = { id, provider: "local", label: id, machine: id, hostId: id, readOnly: false, caseSensitive };
  }

  enableCopyWithin(): void {
    this.copyWithin = async (from, to, opts, signal) => {
      await this.before("copyWithin", to, signal);
      const entry = this.require(from);
      if (entry.kind !== "file") throw new CommanderError("unsupported", "Expected a file");
      this.checkTarget(to, opts.replace, opts.expectTarget);
      this.put(to, entry.bytes);
      return this.fingerprint(this.require(to));
    };
    this.flags.add("serverSideCopy");
  }

  enableChecksum(): void {
    this.sha256 = async (path, signal) => {
      await this.before("sha256", path, signal);
      const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(this.require(path).bytes));
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    this.flags.add("checksum");
  }

  get temporaryCount(): number {
    return [...this.entries].filter((entry) => entry.temporary).length;
  }

  put(path: ResourcePath, bytes: Uint8Array, mtimeNs = String(++this.clock)): void {
    this.set({ path, bytes: bytes.slice(), mtimeNs, kind: "file" });
  }

  contents(path: ResourcePath): Uint8Array | null {
    return this.find(path)?.bytes.slice() ?? null;
  }

  async stat(path: ResourcePath, signal: AbortSignal): Promise<Entry | null> {
    await this.before("stat", path, signal);
    const entry = this.find(path);
    return entry ? this.asEntry(entry) : null;
  }

  async list(path: ResourcePath, opts: { cursor: string | null; limit: number }, signal: AbortSignal) {
    await this.before("list", path, signal);
    const start = Number(opts.cursor ?? 0);
    const children = [...this.entries].filter((entry) => {
      const dir = parent(entry.path);
      return dir && this.same(dir, path);
    });
    const end = start + opts.limit;
    return {
      entries: children.slice(start, end).map((entry) => this.asEntry(entry)),
      cursor: end < children.length ? String(end) : null,
    };
  }

  async read(path: ResourcePath, offset: bigint, length: number, expect: Fingerprint | null, signal: AbortSignal) {
    await this.before("read", path, signal);
    const entry = this.require(path);
    if (entry.kind !== "file") throw new CommanderError("is_a_directory", "Expected a file");
    if (expect && !this.matches(entry, expect)) throw new CommanderError("changed_since_plan", "Source changed");
    if (length > READ_CHUNK_MAX) throw new CommanderError("limit_exceeded", "Chunk too large");
    const bytes = entry.bytes.slice(Number(offset), Number(offset) + length);
    if (this.trackRelayReads) {
      this.liveReadBytes += bytes.byteLength;
      this.peakReadBytes = Math.max(this.peakReadBytes, this.liveReadBytes);
      relayBuffers.set(bytes, () => { this.liveReadBytes -= bytes.byteLength; });
    }
    return bytes;
  }

  async openWrite(path: ResourcePath, opts: Parameters<FileProvider["openWrite"]>[1], signal: AbortSignal): Promise<WriteSession> {
    await this.before("openWrite", path, signal);
    this.forbidRoot(path);
    const dir = parent(path);
    if (!dir) throw new CommanderError("invalid_path", "Cannot write root");
    const tempPath = join(dir, opts.tempName);
    if (this.same(path, tempPath) || this.find(tempPath)) {
      throw new CommanderError("already_exists", "Temporary path already exists");
    }
    this.clock++;
    const temp: StoredEntry = { path: tempPath, bytes: new Uint8Array(), mtimeNs: String(this.clock), kind: "file", temporary: true };
    this.set(temp);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const requireOpen = () => {
      if (!this.entries.has(temp)) throw new CommanderError("not_found", "Session closed");
    };
    return {
      tempPath,
      write: async (offset, bytes, stepSignal) => {
        await this.before("write", path, stepSignal);
        requireOpen();
        if (offset !== BigInt(length)) throw new CommanderError("invalid_path", "Expected sequential offset");
        chunks.push(bytes.slice());
        length += bytes.byteLength;
        temp.size = Math.max(0, length - this.tempStatLag);
        temp.mtimeNs = String(++this.clock);
        relayBuffers.get(bytes)?.();
        relayBuffers.delete(bytes);
      },
      commit: async (opts, stepSignal) => {
        await this.before("commit", path, stepSignal);
        requireOpen();
        this.checkTarget(path, opts.replace, opts.expectTarget ?? undefined);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const entry: StoredEntry = { path, kind: "file", bytes, mtimeNs: String(++this.clock) };
        this.set(entry);
        this.entries.delete(temp);
        chunks.length = 0;
        return this.fingerprint(entry);
      },
      abort: async () => {
        await this.before("abort", path, new AbortController().signal);
        this.entries.delete(temp);
        chunks.length = 0;
      },
    };
  }

  async mkdir(path: ResourcePath, signal: AbortSignal): Promise<void> {
    await this.before("mkdir", path, signal);
    this.forbidRoot(path);
    this.checkTarget(path, false);
    this.set({ path, kind: "dir", bytes: new Uint8Array(), mtimeNs: String(++this.clock) });
  }

  async rename(from: ResourcePath, to: ResourcePath, opts: Parameters<FileProvider["rename"]>[2], signal: AbortSignal): Promise<void> {
    await this.before("rename", to, signal);
    this.forbidRoot(from, to);
    const entry = this.require(from);
    // A case-only change on a case-insensitive endpoint renames the entry onto itself.
    const caseOnly = this.same(from, to) && !samePath(from, to, true);
    if (!caseOnly) this.checkTarget(to, opts.replace, opts.expectTarget);
    if (this.same(from, to) && !caseOnly) return;
    const tree = entry.kind === "dir"
      ? [...this.entries].filter((child) => isAncestorOrSelf(from, child.path, this.endpoint.caseSensitive))
      : [entry];
    for (const child of tree) this.entries.delete(child);
    for (const child of tree) {
      this.set({ ...child, path: { segments: [...to.segments, ...child.path.segments.slice(from.segments.length)] } });
    }
  }

  async remove(path: ResourcePath, opts: Parameters<FileProvider["remove"]>[1], signal: AbortSignal): Promise<void> {
    await this.before("remove", path, signal);
    this.forbidRoot(path);
    const candidate = this.find(path);
    if (opts.expect && (!candidate || !this.matches(candidate, opts.expect))) {
      throw new CommanderError("changed_since_plan", "Source changed");
    }
    const entry = candidate ?? this.require(path);
    if (entry.kind !== opts.kind) throw new CommanderError("changed_since_plan", "Entry type changed");
    if (entry.kind === "dir" && [...this.entries].some((child) => {
      const dir = parent(child.path);
      return dir && this.same(dir, path);
    })) throw new CommanderError("permission_denied", "Directory is not empty");
    this.entries.delete(entry);
  }

  private checkTarget(path: ResourcePath, replace: boolean, expect?: Fingerprint | "absent"): void {
    const entry = this.find(path);
    if (expect && (expect === "absent" ? entry !== undefined : !entry || !this.matches(entry, expect))) {
      throw new CommanderError("changed_since_plan", "Target changed");
    }
    if (entry && !replace) throw new CommanderError("already_exists", "Target exists");
  }

  private async before(op: Op, path: ResourcePath, signal: AbortSignal): Promise<void> {
    if (this.capabilities.has("serverSideCopy") !== (typeof this.copyWithin === "function")
        || this.capabilities.has("checksum") !== (typeof this.sha256 === "function")) {
      throw new CommanderError("internal", "Provider capabilities do not match methods");
    }
    signal.throwIfAborted();
    this.calls.push({ op, path });
    await this.delay?.(op, path, signal);
    signal.throwIfAborted();
    const failure = this.failOn.find((rule) => rule.op === op && rule.times > 0 && this.same(path, rule.path));
    if (failure) {
      failure.times--;
      throw failure.error;
    }
  }

  private same(a: ResourcePath, b: ResourcePath): boolean {
    return samePath(a, b, this.endpoint.caseSensitive);
  }

  private find(path: ResourcePath): StoredEntry | undefined {
    if (path.segments.length === 0) return this.root;
    return [...this.entries].find((entry) => this.same(entry.path, path));
  }

  private require(path: ResourcePath): StoredEntry {
    const entry = this.find(path);
    if (!entry) throw new CommanderError("not_found", "Entry missing");
    return entry;
  }

  private forbidRoot(...paths: ResourcePath[]): void {
    if (paths.some((path) => path.segments.length === 0)) throw new CommanderError("invalid_path", "The root cannot be changed");
  }

  private set(entry: StoredEntry): void {
    this.forbidRoot(entry.path);
    const existing = this.find(entry.path);
    if (existing) this.entries.delete(existing);
    this.entries.add(entry);
  }

  private fingerprint(entry: StoredEntry): Fingerprint {
    return { size: String(entry.size ?? entry.bytes.byteLength), mtimeNs: entry.mtimeNs };
  }

  private matches(entry: StoredEntry, fingerprint: Fingerprint): boolean {
    if (String(entry.size ?? entry.bytes.byteLength) !== fingerprint.size || entry.mtimeNs !== fingerprint.mtimeNs) return false;
    if (!fingerprint.sha256) return true;
    const hash = new TransferHash();
    hash.update(entry.bytes);
    return hash.finish() === fingerprint.sha256;
  }

  private asEntry(entry: StoredEntry): Entry {
    return {
      name: entry.path.segments.at(-1) ?? { t: "root" },
      kind: entry.kind,
      ...this.fingerprint(entry),
      mtimePrecision: "ns",
      mode: null,
      linkTarget: null,
      hidden: entry.temporary ?? false,
    };
  }
}
