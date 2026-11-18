// The RDP part of the helper stdio protocol (mirror of helper/src/protocol.rs
// and helper/src/rdp/protocol.rs) as zod schemas, plus the parser for the
// binary update frames. Host-free; protocol.ts folds these into its unions.
import { z } from "zod";
import { rdpOptionsSchema } from "./rdp-options.ts";

const idSchema = z.number().int().min(0);
const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);
const frameIdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fingerprintSchema = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

/** The largest desktop the helper accepts (B5). */
export const MAX_DESKTOP_WIDTH = 3840;
export const MAX_DESKTOP_HEIGHT = 2160;

/** Closed reasons an RDP session can end with (stage2b contract B2 plus
 *  `server_disconnected`, added in 2b-1). */
export const RDP_CLOSED_REASONS = [
  "auth_failed",
  "cert_rejected",
  "cert_changed",
  "tls_error",
  "protocol_error",
  "network_error",
  "timeout",
  "killed_by_close",
  "engine_exited",
  "helper_shutdown",
  "server_disconnected",
] as const;

/** Connection states, in order (B2). */
export const RDP_STATES = ["connecting", "tls", "cert_prompt", "authenticating", "desktop_ready"] as const;
export type RdpState = (typeof RDP_STATES)[number] | "closed";

const mouseGeometry = {
  x: z.number().int().min(0).max(0xffff_ffff),
  y: z.number().int().min(0).max(0xffff_ffff),
  geom_width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH),
  geom_height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT),
};

/** One input event in the helper's wire format (snake_case fields). */
export const rdpInputEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mouse_move"), ...mouseGeometry }),
  z.object({
    kind: z.literal("mouse_button"),
    button: z.enum(["left", "right", "middle"]),
    down: z.boolean(),
    ...mouseGeometry,
  }),
  z.object({
    kind: z.literal("mouse_wheel"),
    vertical: z.number().int().min(-256).max(255),
    horizontal: z.number().int().min(-256).max(255),
    ...mouseGeometry,
  }),
  z.object({
    kind: z.literal("key"),
    scancode: z.number().int().min(0).max(255),
    extended: z.boolean(),
    down: z.boolean(),
  }),
  z.object({ kind: z.literal("ctrl_alt_del") }),
  z.object({ kind: z.literal("unicode"), text: z.string().min(1).max(256) }),
]);
export type RdpInputEvent = z.infer<typeof rdpInputEventSchema>;

/** Most input events one rdp.input message may carry. */
export const MAX_RDP_INPUT_EVENTS = 256;

// ---- client -> helper ----
export const openRdpRequestSchema = z.object({
  type: z.literal("session.open_rdp"),
  id: idSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  // Exactly one: a password typed for this open, or a saved credential the helper resolves itself.
  password: z.string().optional(),
  credentialRef: z.string().optional(),
  domain: z.string().nullable(),
  width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH),
  height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT),
  expectedFingerprint: z.string().nullable(),
  /** Compression, colour depth and experience switches (closed set; the helper validates them again). */
  options: rdpOptionsSchema.optional(),
}).refine((message) => (message.password === undefined) !== (message.credentialRef === undefined), {
  message: "give exactly one of password and credentialRef",
});
export const rdpCertDecisionRequestSchema = z.object({
  type: z.literal("rdp.cert_decision"),
  id: idSchema,
  sessionId: sessionIdSchema,
  fingerprint: z.string().min(1),
  accept: z.enum(["once", "session_trust", "reject"]),
});
export const rdpInputRequestSchema = z.object({
  type: z.literal("rdp.input"),
  id: idSchema,
  sessionId: sessionIdSchema,
  events: z.array(rdpInputEventSchema).max(MAX_RDP_INPUT_EVENTS),
  /** Who is sending (Z2); "human" when absent. */
  owner: z.string().min(1).max(100).optional(),
});
// strict: the answer to this request carries the same tag, and a malformed
// answer must not be accepted as a request with extra fields stripped.
export const rdpScreenshotRequestSchema = z
  .object({
    type: z.literal("rdp.screenshot"),
    id: idSchema,
    sessionId: sessionIdSchema,
  })
  .strict();
export const rdpUpdateAckRequestSchema = z.object({
  type: z.literal("rdp.update_ack"),
  id: idSchema,
  sessionId: sessionIdSchema,
  frameId: frameIdSchema,
});
export const rdpRefreshRequestSchema = z.object({
  type: z.literal("rdp.refresh"),
  id: idSchema,
  sessionId: sessionIdSchema,
});

// ---- helper -> client ----
export const rdpAckSchema = z.object({ type: z.literal("rdp.ack"), id: idSchema, sessionId: sessionIdSchema });
export const rdpStateSchema = z.object({
  type: z.literal("rdp.state"),
  sessionId: sessionIdSchema,
  state: z.string().min(1),
});
export const rdpCertPromptSchema = z.object({
  type: z.literal("rdp.cert_prompt"),
  sessionId: sessionIdSchema,
  host: z.string(),
  port: z.number().int().min(0).max(65535),
  fingerprint: z.string().min(1),
  subject: z.string(),
  issuer: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  reason: z.string().min(1),
  detail: z.string().nullable().optional(),
  /** The first use of a saved password: accepting pins the password to this certificate. */
  firstUse: z.boolean().optional(),
});
export const rdpCertificateSchema = z.object({
  type: z.literal("rdp.certificate"),
  sessionId: sessionIdSchema,
  fingerprint: z.string().min(1),
  validated: z.boolean(),
});
export const rdpInputRejectedSchema = z.object({
  type: z.literal("rdp.input_rejected"),
  sessionId: sessionIdSchema,
  applied: z.number().int().min(0),
  rejected: z.array(z.object({ index: z.number().int().min(0), code: z.string().min(1) })),
});
export const rdpDesktopSchema = z.object({
  type: z.literal("rdp.desktop"),
  sessionId: sessionIdSchema,
  frameId: frameIdSchema,
  width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH),
  height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT),
  timestamp: z.number().int().min(0),
});
export const rdpScreenshotSchema = z.object({
  type: z.literal("rdp.screenshot"),
  id: idSchema,
  sessionId: sessionIdSchema,
  frameId: frameIdSchema,
  width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH),
  height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT),
  timestamp: z.number().int().min(0),
  png: z.string(),
  /** Present when the PNG arrives as `rdp.screenshot_chunk` frames. */
  chunks: z.number().int().min(2).max(64).optional(),
});
export const rdpScreenshotChunkSchema = z.object({
  type: z.literal("rdp.screenshot_chunk"),
  id: idSchema,
  sessionId: sessionIdSchema,
  index: z.number().int().min(0).max(63),
  count: z.number().int().min(2).max(64),
  data: z.string(),
});

export const rdpRequestSchemas = [
  openRdpRequestSchema,
  rdpCertDecisionRequestSchema,
  rdpInputRequestSchema,
  rdpScreenshotRequestSchema,
  rdpUpdateAckRequestSchema,
  rdpRefreshRequestSchema,
] as const;

export const rdpResponseSchemas = [
  rdpAckSchema,
  rdpStateSchema,
  rdpCertPromptSchema,
  rdpCertificateSchema,
  rdpInputRejectedSchema,
  rdpDesktopSchema,
  rdpScreenshotSchema,
  rdpScreenshotChunkSchema,
] as const;

export type RdpCertPrompt = z.infer<typeof rdpCertPromptSchema>;

/** Helper error codes the TS layer expects for RDP requests (2b-1 follow-ups). */
export const RDP_ERROR_CODES = [
  "not_ready",
  "session_not_found",
  "session_closed",
  "fingerprint_mismatch",
  "no_pending_prompt",
  "rdp_input_overflow",
  "screenshot_busy",
  "screenshot_too_large",
  "rdp_invalid_geometry",
  "rdp_open_failed",
  "response_too_large",
] as const;

export { fingerprintSchema };

// ---- binary update frames (helper -> view) ----
/**
 * frameId u64, fbWidth, fbHeight, x, y, w, h, chunks u32 (all little-endian).
 * `chunks` is the number of bands (frames) the whole update was split into;
 * every band of one update carries the same value.
 */
export const UPDATE_HEADER_BYTES = 36;

export interface RdpUpdateChunk {
  frameId: number;
  fbWidth: number;
  fbHeight: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bands in the whole update this chunk belongs to (at least 1). */
  chunks: number;
  /** Raw RGBA rows, exactly w * h * 4 bytes. */
  pixels: Uint8Array;
}

/**
 * Parse the payload of an RDP update stream frame (what follows the 8-byte
 * sessionId + seq header). Returns null for anything malformed: a short header,
 * an empty or out-of-framebuffer rectangle, a band count of zero or above the framebuffer's rows, a framebuffer above 3840x2160, a
 * frame id above 2^53, or a pixel length different from w * h * 4. The helper
 * validates all of this already; the service does not trust it twice.
 */
export function parseUpdateChunk(payload: Uint8Array): RdpUpdateChunk | null {
  if (payload.byteLength < UPDATE_HEADER_BYTES) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const frameBig = view.getBigUint64(0, true);
  if (frameBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const fbWidth = view.getUint32(8, true);
  const fbHeight = view.getUint32(12, true);
  const x = view.getUint32(16, true);
  const y = view.getUint32(20, true);
  const w = view.getUint32(24, true);
  const h = view.getUint32(28, true);
  const chunks = view.getUint32(32, true);
  if (fbWidth === 0 || fbHeight === 0 || fbWidth > MAX_DESKTOP_WIDTH || fbHeight > MAX_DESKTOP_HEIGHT) return null;
  if (chunks === 0 || chunks > fbHeight) return null;
  if (w === 0 || h === 0 || x + w > fbWidth || y + h > fbHeight) return null;
  const pixels = payload.subarray(UPDATE_HEADER_BYTES);
  if (pixels.byteLength !== w * h * 4) return null;
  return { frameId: Number(frameBig), fbWidth, fbHeight, x, y, w, h, chunks, pixels };
}
