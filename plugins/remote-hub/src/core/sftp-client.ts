// An SFTP client over a byte stream: the operations of sftp-contract.ts in terms of SFTP version 3 requests. It knows
// nothing about ssh, secrets or who is asking: bytes go out through `send`, the server's bytes come in through `feed`.
// Names, paths and data are raw bytes here; turning them into the contract's text/base64 is the adapter's job.
import { SFTP_LIMITS, type SftpRefusalCode } from "./sftp-contract.ts";
import { FX, OPEN, POSIX_RENAME, SftpFramer, SftpProtocolError, decodeReply, encodeRequest, hex, type SftpReply, type SftpRequest, type WireAttrs } from "./sftp-wire.ts";

/** One request's data size: every SFTP server takes this much in a read or a write. */
const PIECE = 32768;
const MAX_PACKET = 256 * 1024 + 1024;
/** Requests in flight at once when one operation needs many. */
const WINDOW = 64;

export class SftpOpError extends Error {
  constructor(readonly code: SftpRefusalCode) {
    super(code);
  }
}

export interface SftpEntryAttrs {
  type: "file" | "dir" | "symlink" | "other";
  size: bigint;
  mtime: number | null;
  mode: number | null;
  /** Where a symlink points, as stored; null for anything else or when it could not be read. */
  linkTarget: Uint8Array | null;
}

export type CreateMode = "exclusive" | "truncate" | "existing";

type Reply = Exclude<SftpReply, { type: "version" }>;
type Body<R> = R extends SftpRequest ? Omit<R, "id"> : never;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; changing: boolean };
/** One contract operation that changes the server: once any of its requests went out, a dead channel means "unknown". */
type Change = { sent: boolean };

const STATUS_CODE: Record<number, SftpRefusalCode> = {
  [FX.NO_SUCH_FILE]: "no_such_file",
  [FX.PERMISSION_DENIED]: "permission_denied",
  [FX.OP_UNSUPPORTED]: "unsupported",
};

function typeOf(mode: number | null): SftpEntryAttrs["type"] {
  if (mode === null) return "other";
  const kind = mode & 0o170000;
  return kind === 0o040000 ? "dir" : kind === 0o100000 ? "file" : kind === 0o120000 ? "symlink" : "other";
}

const attrsOf = (wire: WireAttrs, linkTarget: Uint8Array | null): SftpEntryAttrs => ({ type: typeOf(wire.mode), size: wire.size ?? 0n, mtime: wire.mtime, mode: wire.mode, linkTarget });

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

function join(dir: Uint8Array, name: Uint8Array): Uint8Array {
  const slash = dir.length > 0 && dir[dir.length - 1] === 0x2f;
  const out = new Uint8Array(dir.length + (slash ? 0 : 1) + name.length);
  out.set(dir);
  if (!slash) out[dir.length] = 0x2f;
  out.set(name, out.length - name.length);
  return out;
}

const isDots = (name: Uint8Array): boolean => (name.length === 1 && name[0] === 0x2e) || (name.length === 2 && name[0] === 0x2e && name[1] === 0x2e);

export class SftpClient {
  private readonly framer = new SftpFramer(MAX_PACKET);
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  private version: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private posixRename = false;
  /** The last directory read, so the next pages of the same listing do not read it again. */
  private listing: { path: string; entries: Array<{ name: Uint8Array; attrs: SftpEntryAttrs }> } | null = null;

  constructor(private readonly send: (bytes: Uint8Array) => void) {}

  /** The version exchange. Resolves when the server answered; a server that is not SFTP 3 is refused. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new SftpOpError("channel_closed"));
      this.version = { resolve, reject };
      this.send(encodeRequest({ type: "init" }));
    });
  }

  /** The server's bytes. A malformed stream ends the channel. */
  feed(chunk: Uint8Array): void {
    if (this.dead) return;
    try {
      for (const body of this.framer.push(chunk)) {
        const reply = decodeReply(body);
        if (reply.type === "version") {
          if (reply.version !== 3) throw new SftpProtocolError("not SFTP version 3");
          this.posixRename = reply.extensions[POSIX_RENAME] === "1";
          this.version?.resolve();
          this.version = null;
          continue;
        }
        const waiting = this.pending.get(reply.id);
        if (waiting === undefined) throw new SftpProtocolError("a reply nobody asked for");
        this.pending.delete(reply.id);
        waiting.resolve(reply);
      }
    } catch {
      this.end();
    }
  }

  /** The stream is gone (the channel was closed, revoked, or ssh ended). Everything in flight is answered now. */
  end(): void {
    if (this.dead) return;
    this.dead = true;
    this.version?.reject(new SftpOpError("channel_closed"));
    this.version = null;
    for (const waiting of this.pending.values()) waiting.reject(new SftpOpError(waiting.changing ? "outcome_unknown" : "channel_closed"));
    this.pending.clear();
  }

  private request(body: Body<SftpRequest>, change: Change | null = null): Promise<Reply> {
    return new Promise((resolve, reject) => {
      // Not sent: nothing reached the server for THIS request. Earlier requests of the same change did.
      if (this.dead) return reject(new SftpOpError(change?.sent === true ? "outcome_unknown" : "channel_closed"));
      const id = this.nextId++;
      this.nextId = this.nextId > 0xffffffff ? 1 : this.nextId;
      this.pending.set(id, { resolve, reject, changing: change !== null });
      if (change !== null) change.sent = true;
      this.send(encodeRequest({ ...body, id } as unknown as SftpRequest));
    });
  }

  private fail(reply: Reply): never {
    if (reply.type !== "status") throw new SftpOpError("failure");
    throw new SftpOpError(STATUS_CODE[reply.code] ?? "failure");
  }

  private async ok(body: Body<SftpRequest>, change: Change | null = null): Promise<void> {
    const reply = await this.request(body, change);
    if (reply.type !== "status" || reply.code !== FX.OK) this.fail(reply);
  }

  private async exists(path: Uint8Array): Promise<boolean> {
    const reply = await this.request({ type: "lstat", path });
    return reply.type === "attrs";
  }

  private async openHandle(path: Uint8Array, flags: number, change: Change | null = null): Promise<Uint8Array> {
    const reply = await this.request({ type: "open", path, flags }, change);
    if (reply.type !== "handle") this.fail(reply);
    return reply.handle;
  }

  /** Closing a handle is best effort: the operation's own result stands. */
  private async closeHandle(handle: Uint8Array): Promise<void> {
    await this.request({ type: "close", handle }).catch(() => undefined);
  }

  private async readlink(path: Uint8Array): Promise<Uint8Array | null> {
    const reply = await this.request({ type: "readlink", path }).catch(() => null);
    return reply !== null && reply.type === "name" && reply.entries[0] !== undefined ? reply.entries[0].name : null;
  }

  async stat(path: Uint8Array, follow: boolean): Promise<SftpEntryAttrs> {
    const reply = await this.request({ type: follow ? "stat" : "lstat", path });
    if (reply.type !== "attrs") this.fail(reply);
    const link = !follow && typeOf(reply.attrs.mode) === "symlink" ? await this.readlink(path) : null;
    return attrsOf(reply.attrs, link);
  }

  async realpath(path: Uint8Array): Promise<Uint8Array> {
    const reply = await this.request({ type: "realpath", path });
    if (reply.type !== "name" || reply.entries[0] === undefined) this.fail(reply);
    return reply.entries[0].name;
  }

  private async readDirectory(path: Uint8Array): Promise<Array<{ name: Uint8Array; attrs: SftpEntryAttrs }>> {
    const opened = await this.request({ type: "opendir", path });
    if (opened.type !== "handle") this.fail(opened);
    const found: Array<{ name: Uint8Array; wire: WireAttrs }> = [];
    try {
      for (;;) {
        const reply = await this.request({ type: "readdir", handle: opened.handle });
        if (reply.type === "status" && reply.code === FX.EOF) break;
        if (reply.type !== "name") this.fail(reply);
        for (const e of reply.entries) if (!isDots(e.name)) found.push({ name: e.name, wire: e.attrs });
        if (found.length > SFTP_LIMITS.listTotal) throw new SftpOpError("limit_exceeded");
      }
    } finally {
      await this.closeHandle(opened.handle);
    }
    found.sort((a, b) => compareBytes(a.name, b.name));
    const entries: Array<{ name: Uint8Array; attrs: SftpEntryAttrs }> = [];
    for (let at = 0; at < found.length; at += WINDOW) {
      const batch = found.slice(at, at + WINDOW);
      const links = await Promise.all(batch.map((e) => (typeOf(e.wire.mode) === "symlink" ? this.readlink(join(path, e.name)) : null)));
      batch.forEach((e, i) => entries.push({ name: e.name, attrs: attrsOf(e.wire, links[i] ?? null) }));
    }
    return entries;
  }

  /**
   * One page of a directory, in byte order of the names. `cursor` is what the previous page returned; the pages of one
   * listing come from one reading of the directory, and a cursor that outlived it continues after the same name.
   */
  async list(path: Uint8Array, cursor: string | undefined, limit: number): Promise<{ entries: Array<{ name: Uint8Array; attrs: SftpEntryAttrs }>; nextCursor: string | null }> {
    const key = hex(path);
    if (cursor === undefined || this.listing === null || this.listing.path !== key) this.listing = { path: key, entries: await this.readDirectory(path) };
    const all = this.listing.entries;
    let from = 0;
    if (cursor !== undefined) {
      if (!/^([0-9a-f]{2})+$/.test(cursor)) throw new SftpOpError("invalid_path");
      // The first name after the cursor's, whether or not that name is still there.
      // Hex of the bytes orders the same way the bytes do.
      while (from < all.length && hex((all[from] as { name: Uint8Array }).name) <= cursor) from++;
    }
    const entries = all.slice(from, from + limit);
    const last = entries[entries.length - 1];
    const more = from + limit < all.length && last !== undefined;
    if (!more) this.listing = null;
    return { entries, nextCursor: more ? hex(last.name) : null };
  }

  async read(path: Uint8Array, offset: bigint, length: number): Promise<{ data: Uint8Array; eof: boolean }> {
    const handle = await this.openHandle(path, OPEN.READ);
    try {
      const out = new Uint8Array(length);
      let got = 0;
      let eof = false;
      while (got < length && !eof) {
        // A window of requests at once; a short answer ends the window and the next one starts where the data ended.
        const asks: Array<Promise<Reply>> = [];
        for (let at = got; at < length && asks.length < WINDOW; at += PIECE) asks.push(this.request({ type: "read", handle, offset: offset + BigInt(at), length: Math.min(PIECE, length - at) }));
        const replies = await Promise.all(asks);
        let at = got;
        for (const reply of replies) {
          if (reply.type === "status" && reply.code === FX.EOF) {
            eof = true;
            break;
          }
          if (reply.type !== "data") this.fail(reply);
          const want = Math.min(PIECE, length - at);
          out.set(reply.data.subarray(0, want), at);
          at += Math.min(reply.data.length, want);
          if (reply.data.length < want) break; // short: ask again from here
        }
        if (at === got && !eof) throw new SftpOpError("failure"); // a server that returns nothing and no EOF
        got = at;
      }
      return { data: out.slice(0, got), eof };
    } finally {
      await this.closeHandle(handle);
    }
  }

  async write(path: Uint8Array, offset: bigint, data: Uint8Array, create: CreateMode): Promise<{ written: number }> {
    const change: Change = { sent: false };
    const flags = OPEN.WRITE | (create === "exclusive" ? OPEN.CREAT | OPEN.EXCL : create === "truncate" ? OPEN.CREAT | OPEN.TRUNC : 0);
    let handle: Uint8Array;
    try {
      handle = await this.openHandle(path, flags, change);
    } catch (e) {
      // OpenSSH answers a plain FAILURE for "already there": say which it was.
      if (create === "exclusive" && e instanceof SftpOpError && e.code === "failure" && (await this.exists(path).catch(() => false))) throw new SftpOpError("exists");
      throw e;
    }
    try {
      for (let at = 0; at < data.length; at += PIECE * WINDOW) {
        const asks: Array<Promise<void>> = [];
        for (let p = at; p < data.length && p < at + PIECE * WINDOW; p += PIECE) asks.push(this.ok({ type: "write", handle, offset: offset + BigInt(p), data: data.subarray(p, Math.min(p + PIECE, data.length)) }, change));
        await Promise.all(asks);
      }
      return { written: data.length };
    } finally {
      await this.closeHandle(handle);
    }
  }

  async mkdir(path: Uint8Array): Promise<void> {
    try {
      await this.ok({ type: "mkdir", path }, { sent: false });
    } catch (e) {
      if (e instanceof SftpOpError && e.code === "failure" && (await this.exists(path).catch(() => false))) throw new SftpOpError("exists");
      throw e;
    }
  }

  /** `overwrite`: an atomic replace, only with the server's posix-rename; without it the answer is always `unsupported`. */
  async rename(from: Uint8Array, to: Uint8Array, overwrite: boolean): Promise<void> {
    if (overwrite) {
      if (!this.posixRename) throw new SftpOpError("unsupported");
      return this.ok({ type: "posix-rename", from, to }, { sent: false });
    }
    if (await this.exists(to)) throw new SftpOpError("exists");
    await this.ok({ type: "rename", from, to }, { sent: false });
  }

  async remove(path: Uint8Array, kind: "file" | "dir"): Promise<void> {
    try {
      await this.ok({ type: kind === "file" ? "remove" : "rmdir", path }, { sent: false });
    } catch (e) {
      if (kind === "dir" && e instanceof SftpOpError && e.code === "failure") {
        const inside = await this.readDirectory(path).catch(() => null);
        if (inside !== null && inside.length > 0) throw new SftpOpError("not_empty");
      }
      throw e;
    }
  }
}
