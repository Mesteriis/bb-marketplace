import { z } from "zod";
import { ErrorCode, ErrorReason } from "../errors.ts";

/**
 * Wire contract between the plugin and the archive helper (S14 spec §4).
 * Frame: [u32 LE body length][body]; body[0] = kind. 0x01 control JSON, 0x02 data
 * (u32 LE reqId + bytes), 0x03 secret (u32 LE reqId + UTF-8, adapter -> helper only).
 */

export const PROTOCOL_VERSION = 1;

export const FRAME_LIMITS = {
  controlMax: 1024 * 1024,
  dataMax: 4 * 1024 * 1024,
  secretMax: 1024,
} as const;

const KIND_CONTROL = 0x01;
const KIND_DATA = 0x02;
const KIND_SECRET = 0x03;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function frame(kind: number, head: Uint8Array, payload: Uint8Array): Uint8Array {
  const body = head.length + payload.length + 1;
  const out = new Uint8Array(4 + body);
  new DataView(out.buffer).setUint32(0, body, true);
  out[4] = kind;
  out.set(head, 5);
  out.set(payload, 5 + head.length);
  return out;
}

function reqIdBytes(reqId: number): Uint8Array {
  if (!Number.isInteger(reqId) || reqId < 1 || reqId > 0xffffffff) throw new ProtocolError("Invalid request id");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, reqId, true);
  return out;
}

export function encodeControl(message: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  if (json.length + 1 > FRAME_LIMITS.controlMax) throw new ProtocolError("Control frame is too large");
  return frame(KIND_CONTROL, new Uint8Array(0), json);
}

export function encodeData(reqId: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length > FRAME_LIMITS.dataMax) throw new ProtocolError("Data frame is too large");
  return frame(KIND_DATA, reqIdBytes(reqId), bytes);
}

export function encodeSecret(reqId: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length < 1 || bytes.length > FRAME_LIMITS.secretMax) throw new ProtocolError("Invalid secret length");
  return frame(KIND_SECRET, reqIdBytes(reqId), bytes);
}

/** A secret frame never prints its payload, in any serialisation. */
export class SecretFrame {
  readonly kind = "secret" as const;
  constructor(readonly reqId: number, private readonly payload: Uint8Array) {}
  get length(): number {
    return this.payload.length;
  }
  /** The only way to reach the bytes; callers must clear them after use. */
  take(): Uint8Array {
    return this.payload;
  }
  toJSON() {
    return { kind: this.kind, reqId: this.reqId, length: this.length };
  }
  toString(): string {
    return `SecretFrame(${this.length} bytes)`;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export type Frame =
  | { kind: "control"; json: Record<string, unknown> }
  | { kind: "data"; reqId: number; bytes: Uint8Array }
  | SecretFrame;

export type Direction = "from-helper" | "from-adapter";

/** Incremental decoder. After the first violation it fails for good. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);
  private failed: ProtocolError | null = null;
  constructor(private readonly direction: Direction) {}

  private fail(message: string): never {
    this.failed = new ProtocolError(message);
    this.buffer = new Uint8Array(0);
    throw this.failed;
  }

  push(chunk: Uint8Array): Frame[] {
    if (this.failed) throw this.failed;
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const frames: Frame[] = [];
    while (this.buffer.length >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = view.getUint32(0, true);
      if (length === 0) this.fail("Empty frame");
      // The length is judged before anything is allocated for the body.
      if (length > FRAME_LIMITS.dataMax + 5 && length > FRAME_LIMITS.controlMax) this.fail("Frame is too large");
      if (this.buffer.length < 4 + length) {
        // Early rejection of an oversized control or data frame once the kind byte is known.
        if (this.buffer.length >= 5) this.checkEnvelope(this.buffer[4] as number, length);
        break;
      }
      const body = this.buffer.subarray(4, 4 + length);
      frames.push(this.decodeBody(body));
      this.buffer = this.buffer.slice(4 + length);
    }
    return frames;
  }

  private checkEnvelope(kind: number, length: number): void {
    if (kind === KIND_CONTROL) {
      if (length < 2 || length > FRAME_LIMITS.controlMax) this.fail("Control frame length out of range");
    } else if (kind === KIND_DATA) {
      if (length < 5 || length > FRAME_LIMITS.dataMax + 5) this.fail("Data frame length out of range");
    } else if (kind === KIND_SECRET) {
      if (this.direction === "from-helper") this.fail("Secret frame from the helper");
      if (length < 6 || length > FRAME_LIMITS.secretMax + 5) this.fail("Secret frame length out of range");
    } else this.fail("Unknown frame kind");
  }

  private decodeBody(body: Uint8Array): Frame {
    const kind = body[0] as number;
    this.checkEnvelope(kind, body.length);
    if (kind === KIND_CONTROL) {
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(1)));
      } catch {
        this.fail("Control frame is not valid UTF-8 JSON");
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail("Control frame is not an object");
      return { kind: "control", json: value as Record<string, unknown> };
    }
    const reqId = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, true);
    const payload = body.slice(5);
    if (kind === KIND_DATA) return { kind: "data", reqId, bytes: payload };
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      this.fail("Secret frame is not valid UTF-8");
    }
    return new SecretFrame(reqId, payload);
  }
}

const base64 = z.string().min(1).max(8192).refine((value) => {
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
});
const decimal = z.string().regex(/^(0|[1-9]\d{0,20})$/);

export const HelloMessage = z.object({
  t: z.literal("hello"),
  protocol: z.number().int(),
  helper: z.string().min(1).max(32),
  zip: z.string().min(1).max(32),
  tar: z.string().min(1).max(32),
  rlimit_as: z.enum(["enforced", "not_enforced", "failed"]),
}).strict();
export type HelloMessage = z.infer<typeof HelloMessage>;

export const Limits = z.object({
  maxTotalBytes: z.number().int().positive(),
  maxEntries: z.number().int().positive(),
  maxRatio: z.number().int().positive(),
}).strict();

export const OpenExpect = z.object({ size: decimal, mtimeNs: decimal, dev: decimal, ino: decimal }).strict();

const Req = z.number().int().min(1).max(0xffffffff);

export const OpenRequest = z.object({
  t: z.literal("open"),
  req: Req,
  rootB64: base64,
  segmentsB64: z.array(base64).max(4096),
  format: z.enum(["auto", "zip", "tar"]),
  limits: Limits,
  expect: OpenExpect,
}).strict();
export type OpenRequest = z.infer<typeof OpenRequest>;

export const ListRequest = z.object({
  t: z.literal("list"), req: Req, prefixB64: z.string().max(8192),
  cursor: z.string().max(64).nullable(), limit: z.number().int().min(1).max(1000),
}).strict();
export const StatRequest = z.object({ t: z.literal("stat"), req: Req, nameB64: base64 }).strict();
export const ReadOpenRequest = z.object({ t: z.literal("read_open"), req: Req, id: z.number().int().min(0) }).strict();
export const ReadRequest = z.object({
  t: z.literal("read"), req: Req, stream: z.number().int().min(1), length: z.number().int().min(1).max(FRAME_LIMITS.dataMax),
}).strict();
export const ReadFinishRequest = z.object({ t: z.literal("read_finish"), req: Req, stream: z.number().int().min(1) }).strict();
export const ReadCloseRequest = z.object({ t: z.literal("read_close"), req: Req, stream: z.number().int().min(1) }).strict();
export const VerifyRequest = z.object({ t: z.literal("verify"), req: Req }).strict();
export const CancelRequest = z.object({ t: z.literal("cancel"), req: Req, target: Req }).strict();
export const CloseRequest = z.object({ t: z.literal("close"), req: Req }).strict();

export const Request = z.discriminatedUnion("t", [
  OpenRequest, ListRequest, StatRequest, ReadOpenRequest, ReadRequest, ReadFinishRequest, ReadCloseRequest,
  VerifyRequest, CancelRequest, CloseRequest,
]);
export type Request = z.infer<typeof Request>;

export const ErrResponse = z.object({
  t: z.literal("err"), req: Req, code: ErrorCode, reason: ErrorReason.optional(), message: z.string().max(500),
}).strict();
export const OkResponse = z.object({ t: z.literal("ok"), req: Req }).passthrough();
export const NeedPassword = z.object({ t: z.literal("need_password"), req: Req }).strict();
export const Response = z.union([OkResponse, ErrResponse, NeedPassword]);
export type Response = z.infer<typeof Response>;

export const ArchiveEntry = z.object({
  id: z.number().int().min(0),
  nameB64: z.string().max(8192),
  name: z.string().max(4096),
  nameLossy: z.boolean(),
  kind: z.enum(["file", "dir", "symlink", "hardlink", "special"]),
  size: decimal,
  csize: decimal,
  mtime: z.number().nullable(),
  mode: z.number().int().nullable(),
  encrypted: z.boolean(),
  linkB64: z.string().max(8192).optional(),
  synthetic: z.boolean().optional(),
}).strict();
export type ArchiveEntry = z.infer<typeof ArchiveEntry>;
