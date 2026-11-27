// The SFTP (version 3) wire format: requests to bytes, replies from bytes, and the framing of the byte stream. Pure and
// host-free (Uint8Array only). Names and handles are raw bytes here: nothing is decoded as text at this level.

export const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15,
  REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105, EXTENDED: 200,
} as const;

/** Status codes of SSH_FXP_STATUS. */
export const FX = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8 } as const;

/** Flags of SSH_FXP_OPEN. */
export const OPEN = { READ: 0x01, WRITE: 0x02, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 } as const;

export const POSIX_RENAME = "posix-rename@openssh.com";

export class SftpProtocolError extends Error {}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

class Writer {
  private parts: Uint8Array[] = [];
  private size = 0;
  private add(part: Uint8Array): this {
    this.parts.push(part);
    this.size += part.length;
    return this;
  }
  u8(v: number): this {
    return this.add(Uint8Array.of(v));
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    return this.add(b);
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v);
    return this.add(b);
  }
  str(v: Uint8Array): this {
    return this.u32(v.length).add(v);
  }
  /** The packet: its length, then everything written. */
  packet(): Uint8Array {
    const out = new Uint8Array(4 + this.size);
    new DataView(out.buffer).setUint32(0, this.size);
    let at = 4;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export type SftpRequest =
  | { type: "init" }
  | { type: "open"; id: number; path: Uint8Array; flags: number }
  | { type: "close"; id: number; handle: Uint8Array }
  | { type: "read"; id: number; handle: Uint8Array; offset: bigint; length: number }
  | { type: "write"; id: number; handle: Uint8Array; offset: bigint; data: Uint8Array }
  | { type: "lstat" | "stat" | "opendir" | "remove" | "mkdir" | "rmdir" | "realpath" | "readlink"; id: number; path: Uint8Array }
  | { type: "readdir"; id: number; handle: Uint8Array }
  | { type: "rename" | "posix-rename"; id: number; from: Uint8Array; to: Uint8Array };

const PATH_TYPE = { lstat: T.LSTAT, stat: T.STAT, opendir: T.OPENDIR, remove: T.REMOVE, mkdir: T.MKDIR, rmdir: T.RMDIR, realpath: T.REALPATH, readlink: T.READLINK } as const;
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function encodeRequest(r: SftpRequest): Uint8Array {
  const w = new Writer();
  switch (r.type) {
    case "init":
      return w.u8(T.INIT).u32(3).packet();
    case "open":
      // Empty attributes: the server's default mode, minus its umask.
      return w.u8(T.OPEN).u32(r.id).str(r.path).u32(r.flags).u32(0).packet();
    case "close":
      return w.u8(T.CLOSE).u32(r.id).str(r.handle).packet();
    case "read":
      return w.u8(T.READ).u32(r.id).str(r.handle).u64(r.offset).u32(r.length).packet();
    case "write":
      return w.u8(T.WRITE).u32(r.id).str(r.handle).u64(r.offset).str(r.data).packet();
    case "readdir":
      return w.u8(T.READDIR).u32(r.id).str(r.handle).packet();
    case "rename":
      return w.u8(T.RENAME).u32(r.id).str(r.from).str(r.to).packet();
    case "posix-rename":
      return w.u8(T.EXTENDED).u32(r.id).str(ascii(POSIX_RENAME)).str(r.from).str(r.to).packet();
    case "mkdir":
      return w.u8(T.MKDIR).u32(r.id).str(r.path).u32(0).packet();
    default:
      return w.u8(PATH_TYPE[r.type]).u32(r.id).str(r.path).packet();
  }
}

export class PacketReader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.at + n > this.bytes.length) throw new SftpProtocolError("truncated SFTP packet");
  }
  get done(): boolean {
    return this.at >= this.bytes.length;
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.at++] as number;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.at);
    this.at += 8;
    return v;
  }
  /** A copy: the caller may keep it after the packet's buffer is reused. */
  str(): Uint8Array {
    const n = this.u32();
    this.need(n);
    const v = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return v;
  }
}

export interface WireAttrs {
  size: bigint | null;
  /** The mode with the file type bits. */
  mode: number | null;
  /** Seconds since the epoch. */
  mtime: number | null;
}

export function decodeAttrs(r: PacketReader): WireAttrs {
  const flags = r.u32();
  const attrs: WireAttrs = { size: null, mode: null, mtime: null };
  if (flags & 0x1) attrs.size = r.u64();
  if (flags & 0x2) {
    r.u32();
    r.u32();
  }
  if (flags & 0x4) attrs.mode = r.u32();
  if (flags & 0x8) {
    r.u32();
    attrs.mtime = r.u32();
  }
  if (flags & 0x80000000) {
    for (let n = r.u32(); n > 0; n--) {
      r.str();
      r.str();
    }
  }
  return attrs;
}

export type SftpReply =
  | { type: "version"; version: number; extensions: Record<string, string> }
  | { type: "status"; id: number; code: number }
  | { type: "handle"; id: number; handle: Uint8Array }
  | { type: "data"; id: number; data: Uint8Array }
  | { type: "name"; id: number; entries: Array<{ name: Uint8Array; attrs: WireAttrs }> }
  | { type: "attrs"; id: number; attrs: WireAttrs };

const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

/** One reply from a packet's body (without its length). */
export function decodeReply(body: Uint8Array): SftpReply {
  const r = new PacketReader(body);
  const type = r.u8();
  if (type === T.VERSION) {
    const version = r.u32();
    const extensions: Record<string, string> = {};
    while (!r.done) extensions[latin1(r.str())] = latin1(r.str());
    return { type: "version", version, extensions };
  }
  const id = r.u32();
  switch (type) {
    case T.STATUS:
      // The message and language that follow are the server's text: never shown, never logged.
      return { type: "status", id, code: r.u32() };
    case T.HANDLE:
      return { type: "handle", id, handle: r.str() };
    case T.DATA:
      return { type: "data", id, data: r.str() };
    case T.ATTRS:
      return { type: "attrs", id, attrs: decodeAttrs(r) };
    case T.NAME: {
      const entries: Array<{ name: Uint8Array; attrs: WireAttrs }> = [];
      for (let n = r.u32(); n > 0; n--) {
        const name = r.str();
        r.str(); // the long name is a display line for humans
        entries.push({ name, attrs: decodeAttrs(r) });
      }
      return { type: "name", id, entries };
    }
    default:
      throw new SftpProtocolError(`unknown SFTP reply type ${type}`);
  }
}

/** Cuts the server's byte stream into packet bodies. */
export class SftpFramer {
  private buffer = new Uint8Array(0);
  constructor(private readonly maxPacket: number) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const out: Uint8Array[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, at, 4).getUint32(0);
      if (length === 0) throw new SftpProtocolError("empty SFTP packet");
      if (length > this.maxPacket) throw new SftpProtocolError("SFTP packet too long");
      if (joined.length - at - 4 < length) break;
      out.push(joined.slice(at + 4, at + 4 + length));
      at += 4 + length;
    }
    this.buffer = joined.slice(at);
    return out;
  }
}
