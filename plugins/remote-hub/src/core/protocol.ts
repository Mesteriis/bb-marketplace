// The versioned IPC contract between the Remote Hub TypeScript layer and the
// Rust helper. Both sides speak length-prefixed frames over stdio:
//
//   [ u32 LE body length ][ body ]
//   body[0]   = frame kind: 0x01 control (JSON), 0x02 binary stream
//   control   = body[0] kind, body[1..] UTF-8 JSON control message
//   stream    = body[0] kind, body[1..5] u32 LE sessionId,
//               body[5..9] u32 LE seq, body[9..] terminal bytes
//
// The Rust mirror lives in helper/src/protocol.rs and must stay in sync with
// these constants and message names.
import { credentialRequestSchemas, credentialResponseSchemas } from "./credential-protocol.ts";
import { knownHostsRequestSchemas, knownHostsResponseSchemas } from "./known-hosts-protocol.ts";
import { sshAskpassRequestSchemas, sshAskpassResponseSchemas } from "./ssh-askpass-protocol.ts";
import { z } from "zod";
import {
  openRdpRequestSchema,
  rdpAckSchema,
  rdpCertDecisionRequestSchema,
  rdpCertPromptSchema,
  rdpCertificateSchema,
  rdpDesktopSchema,
  rdpInputRejectedSchema,
  rdpInputRequestSchema,
  rdpRefreshRequestSchema,
  rdpRequestSchemas,
  rdpResponseSchemas,
  rdpScreenshotChunkSchema,
  rdpScreenshotRequestSchema,
  rdpScreenshotSchema,
  rdpStateSchema,
  rdpUpdateAckRequestSchema,
} from "./rdp-protocol.ts";

export const PROTOCOL_VERSION = 1;
/** Largest body (everything after the 4-byte length prefix) the codec accepts. */
export const MAX_FRAME_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB
export const FRAME_KIND_CONTROL = 0x01;
export const FRAME_KIND_STREAM = 0x02;
/** Stream frame header bytes after the kind byte: sessionId (u32) + seq (u32). */
export const STREAM_HEADER_BYTES = 8;

const idSchema = z.number().int().min(0);
const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);
const sizeSchema = z.number().int().min(1).max(65535);

/** Client -> helper control messages. */
export const helloRequestSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int().positive(),
});
export const pingRequestSchema = z.object({
  type: z.literal("ping"),
  id: idSchema,
});
export const openEchoRequestSchema = z.object({
  type: z.literal("session.open_echo"),
  id: idSchema,
  cols: sizeSchema,
  rows: sizeSchema,
});
export const openSshRequestSchema = z.object({
  type: z.literal("session.open_ssh"),
  id: idSchema,
  cols: sizeSchema,
  rows: sizeSchema,
  program: z.string().min(1),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().nullable(),
  /** A saved credential whose secret prompt the helper answers from the Keychain (stage 3b-2). */
  askpass: z.object({ credentialRef: z.string().min(1).max(96) }).optional(),
});
/** Maximum UTF-8 bytes a single session.input may carry (matches Rust PENDING_INPUT_CAP). */
export const MAX_SESSION_INPUT_BYTES = 262_144;

/** True when the string contains no unpaired UTF-16 surrogates. */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate must be followed by a low surrogate.
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false; // lone low surrogate
    }
  }
  return true;
}

/** Host-free validator shared by the IPC protocol and the BB RPC schema. */
export const sessionInputDataSchema = z
  .string()
  .min(1)
  .refine(isWellFormedUtf16, { message: "session input must be well-formed UTF-16" })
  .refine((value) => new TextEncoder().encode(value).length <= MAX_SESSION_INPUT_BYTES, {
    message: "session input exceeds " + MAX_SESSION_INPUT_BYTES + " UTF-8 bytes",
  });

export const sessionInputRequestSchema = z.object({
  type: z.literal("session.input"),
  id: idSchema,
  sessionId: sessionIdSchema,
  data: sessionInputDataSchema,
});
export const sessionResizeRequestSchema = z.object({
  type: z.literal("session.resize"),
  id: idSchema,
  sessionId: sessionIdSchema,
  cols: sizeSchema,
  rows: sizeSchema,
});
export const sessionCreditRequestSchema = z.object({
  type: z.literal("session.credit"),
  id: idSchema,
  sessionId: sessionIdSchema,
  bytes: z.number().int().min(0),
});
export const sessionCloseRequestSchema = z.object({
  type: z.literal("session.close"),
  id: idSchema,
  sessionId: sessionIdSchema,
});

/** Helper -> client control messages. */
export const helloAckSchema = z.object({
  type: z.literal("hello_ack"),
  protocol: z.number().int().positive(),
  helperVersion: z.string().min(1),
  platform: z.string().min(1),
  pid: z.number().int().positive(),
  generation: z.string().regex(/^[0-9a-f]{32}$/),
});
export const pongSchema = z.object({
  type: z.literal("pong"),
  id: idSchema,
});
export const sessionOpenedSchema = z.object({
  type: z.literal("session.opened"),
  id: idSchema,
  sessionId: sessionIdSchema,
  // An RDP session has no character grid: the helper reports 0 x 0.
  cols: z.number().int().min(0).max(65535),
  rows: z.number().int().min(0).max(65535),
  kind: z.string().min(1),
});
export const sessionInputAckSchema = z.object({
  type: z.literal("session.input_ack"),
  id: idSchema,
  sessionId: sessionIdSchema,
});
export const sessionResizedSchema = z.object({
  type: z.literal("session.resized"),
  id: idSchema,
  sessionId: sessionIdSchema,
  cols: sizeSchema,
  rows: sizeSchema,
});
export const sessionCreditAckSchema = z.object({
  type: z.literal("session.credit_ack"),
  id: idSchema,
  sessionId: sessionIdSchema,
});
export const sessionClosedSchema = z.object({
  type: z.literal("session.closed"),
  id: idSchema.nullable(),
  sessionId: sessionIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: z.string().min(1),
});
export const errorEnvelopeSchema = z.object({
  type: z.literal("error"),
  id: idSchema.nullable(),
  code: z.string().min(1),
  message: z.string(),
});

export const requestSchema = z.discriminatedUnion("type", [
  ...credentialRequestSchemas,
  ...knownHostsRequestSchemas,
  ...sshAskpassRequestSchemas,
  helloRequestSchema,
  pingRequestSchema,
  openEchoRequestSchema,
  openSshRequestSchema,
  sessionInputRequestSchema,
  sessionResizeRequestSchema,
  sessionCreditRequestSchema,
  sessionCloseRequestSchema,
  ...rdpRequestSchemas,
]);

export const responseSchema = z.discriminatedUnion("type", [
  ...credentialResponseSchemas,
  ...knownHostsResponseSchemas,
  ...sshAskpassResponseSchemas,
  helloAckSchema,
  pongSchema,
  sessionOpenedSchema,
  sessionInputAckSchema,
  sessionResizedSchema,
  sessionCreditAckSchema,
  sessionClosedSchema,
  errorEnvelopeSchema,
  ...rdpResponseSchemas,
]);

// `rdp.screenshot` is both a request ({id, sessionId}) and the answer to it, so a
// discriminated union cannot hold both; the two shapes sit beside it in a union.
export const controlMessageSchema = z.union([
  z.discriminatedUnion("type", [
    helloRequestSchema,
    pingRequestSchema,
    openEchoRequestSchema,
    openSshRequestSchema,
    sessionInputRequestSchema,
    sessionResizeRequestSchema,
    sessionCreditRequestSchema,
    sessionCloseRequestSchema,
    helloAckSchema,
    pongSchema,
    sessionOpenedSchema,
    sessionInputAckSchema,
    sessionResizedSchema,
    sessionCreditAckSchema,
    sessionClosedSchema,
    errorEnvelopeSchema,
    ...credentialRequestSchemas,
    ...credentialResponseSchemas,
    ...knownHostsRequestSchemas,
    ...knownHostsResponseSchemas,
    ...sshAskpassRequestSchemas,
    ...sshAskpassResponseSchemas,
    openRdpRequestSchema,
    rdpCertDecisionRequestSchema,
    rdpInputRequestSchema,
    rdpUpdateAckRequestSchema,
    rdpRefreshRequestSchema,
    rdpAckSchema,
    rdpStateSchema,
    rdpCertPromptSchema,
    rdpCertificateSchema,
    rdpInputRejectedSchema,
    rdpDesktopSchema,
    rdpScreenshotChunkSchema,
  ]),
  rdpScreenshotSchema,
  rdpScreenshotRequestSchema,
]);

export const streamFrameHeaderSchema = z.object({
  sessionId: sessionIdSchema,
  seq: z.number().int().min(0).max(0xffff_ffff),
});

export type ControlMessage = z.infer<typeof controlMessageSchema>;
export type RequestMessage = z.infer<typeof requestSchema>;
export type ResponseMessage = z.infer<typeof responseSchema>;
export type StreamFrameHeader = z.infer<typeof streamFrameHeaderSchema>;

export type DecodedFrame =
  | { kind: "control"; message: ControlMessage }
  | { kind: "stream"; header: StreamFrameHeader; data: Uint8Array };

export type DecodeFrameResult =
  | { status: "need_more_data" }
  | { status: "frame"; frame: DecodedFrame; remaining: Uint8Array }
  | { status: "error"; code: string; message: string };

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function encodeFrameBody(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + body.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, body.length, true);
  frame.set(body, 4);
  return frame;
}

/** Encode a validated control message as a single length-prefixed frame. */
export function encodeControlFrame(message: ControlMessage): Uint8Array {
  const json = JSON.stringify(controlMessageSchema.parse(message));
  const body = concatBytes(Uint8Array.of(FRAME_KIND_CONTROL), new TextEncoder().encode(json));
  return encodeFrameBody(body);
}

/** Encode a binary stream frame (sessionId, seq, then terminal bytes). */
export function encodeStreamFrame(header: StreamFrameHeader, data: Uint8Array): Uint8Array {
  const { sessionId, seq } = streamFrameHeaderSchema.parse(header);
  const body = new Uint8Array(1 + STREAM_HEADER_BYTES + data.length);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  body[0] = FRAME_KIND_STREAM;
  view.setUint32(1, sessionId, true);
  view.setUint32(5, seq, true);
  body.set(data, 1 + STREAM_HEADER_BYTES);
  return encodeFrameBody(body);
}

/**
 * Decode at most one frame from the front of a buffer. Never throws on
 * malformed input: it returns "need_more_data" for a truncated buffer and an
 * "error" result for a frame that is too large or does not match the schema.
 */
export function decodeFrame(buffer: Uint8Array): DecodeFrameResult {
  if (buffer.byteLength < 4) return { status: "need_more_data" };
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const bodyLength = view.getUint32(0, true);
  if (bodyLength > MAX_FRAME_BODY_BYTES) {
    return {
      status: "error",
      code: "frame_too_large",
      message: `frame body length ${bodyLength} exceeds the ${MAX_FRAME_BODY_BYTES} byte limit`,
    };
  }
  if (bodyLength < 1) {
    return { status: "error", code: "invalid_frame", message: "frame body length 0 is invalid" };
  }
  if (buffer.byteLength < 4 + bodyLength) return { status: "need_more_data" };
  const body = buffer.subarray(4, 4 + bodyLength);
  const remaining = buffer.subarray(4 + bodyLength);
  const kind = body[0];
  if (kind === FRAME_KIND_CONTROL) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(body.subarray(1)));
    } catch {
      return { status: "error", code: "invalid_json", message: "control frame body is not valid JSON" };
    }
    const parsed = controlMessageSchema.safeParse(value);
    if (!parsed.success) {
      return { status: "error", code: "invalid_control_frame", message: "control frame body does not match the schema" };
    }
    return { status: "frame", frame: { kind: "control", message: parsed.data }, remaining };
  }
  if (kind === FRAME_KIND_STREAM) {
    if (body.byteLength < 1 + STREAM_HEADER_BYTES) {
      return { status: "error", code: "invalid_stream_frame", message: "stream frame is shorter than its header" };
    }
    const header: StreamFrameHeader = {
      sessionId: view.getUint32(5, true),
      seq: view.getUint32(9, true),
    };
    const data = body.subarray(1 + STREAM_HEADER_BYTES);
    return { status: "frame", frame: { kind: "stream", header, data }, remaining };
  }
  return { status: "error", code: "unknown_frame_kind", message: `unknown frame kind ${kind}` };
}
