// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";
import { credentialBindSchema } from "./credential.ts";
import { profileInputSchema, profileSchema } from "./profile.ts";
import { sessionInputDataSchema } from "./protocol.ts";
import { MAX_DESKTOP_HEIGHT, MAX_DESKTOP_WIDTH, RDP_CLOSED_REASONS } from "./rdp-protocol.ts";
import { assertHostToken } from "./ssh-args.ts";

const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);
const sizeSchema = z.number().int().min(1).max(10_000);

export const sessionHandleSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{32}$/),
  sessionId: sessionIdSchema,
});

export const helperStatusSchema = z.object({
  version: z.string().min(1),
  pid: z.number().int().positive(),
  platform: z.string().min(1),
  sessionCount: z.number().int().min(0),
  alive: z.boolean(),
});

const sshTargetSchema = z.object({
  host: z.string().min(1),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  configFile: z.string().optional(),
  knownHostsFile: z.string().optional(),
  identityFile: z.string().optional(),
  extraOptions: z.array(z.string()).default([]),
});

/** A host that passes the SSH host rules (no leading '-', no shell metacharacters). */
const rdpHostSchema = z.string().min(1).max(255).refine(
  (host) => {
    try {
      assertHostToken(host);
      return true;
    } catch {
      return false;
    }
  },
  { message: "host contains a character that is not allowed" },
);

const rdpTargetSchema = z.object({
  host: rdpHostSchema,
  port: z.number().int().min(1).max(65535).default(3389),
  username: z.string().min(1).max(256),
  // Exactly one of the two. A password exists only in this payload, the helper
  // frame and engine memory; never echoed, logged, listed or kept in a session
  // record. A credentialRef names a saved credential: it is checked against the
  // endpoint it was saved for, and the helper resolves it from the Keychain.
  password: z.string().max(1024).optional(),
  credentialRef: z.string().max(96).optional(),
  domain: z.string().min(1).max(256).optional(),
  expectedFingerprint: z.string().min(1).max(95).optional(),
}).refine((target) => (target.password === undefined) !== (target.credentialRef === undefined), {
  message: "give exactly one of password and credentialRef",
});

export const rdpCertPromptInfoSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  fingerprint: z.string(),
  subject: z.string(),
  issuer: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  /** untrusted_root, hostname_mismatch, expired, other, or cert_changed (the service's override). */
  reason: z.string(),
});

export const rdpInfoSchema = z.object({
  /** The endpoint, never the password. */
  target: z.object({ host: z.string(), port: z.number().int(), username: z.string(), domain: z.string().nullable() }),
  state: z.enum(["connecting", "tls", "cert_prompt", "authenticating", "desktop_ready", "closed"]),
  prompt: rdpCertPromptInfoSchema.nullable(),
  desktop: z.object({ frameId: z.number().int(), width: z.number().int(), height: z.number().int() }).nullable(),
  /** Every state seen so far, in order (a trace the integration tests assert on). */
  trace: z.array(z.string()),
});

export const sessionInfoSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{32}$/),
  sessionId: sessionIdSchema,
  kind: z.enum(["echo", "ssh", "rdp"]),
  state: z.enum(["connecting", "running", "closed"]),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: z.string().nullable(),
  rdp: rdpInfoSchema.optional(),
  /** The saved profile the session was opened from, when it was. */
  profileId: z.string().uuid().optional(),
});

export const credentialViewSchema = z.object({
  ref: z.string(),
  kind: z.enum(["password", "passphrase"]),
  label: z.string(),
  bind: credentialBindSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  usedBy: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const rpcSchemas = {
  helper_status: {
    input: z.null(),
    output: helperStatusSchema,
  },
  echo_open: {
    input: z.object({ cols: sizeSchema.default(80), rows: sizeSchema.default(24) }),
    output: sessionHandleSchema,
  },
  echo_input: {
    input: sessionHandleSchema.extend({ data: sessionInputDataSchema }),
    output: z.object({ output: z.string(), truncated: z.boolean() }),
  },
  echo_close: {
    input: sessionHandleSchema,
    output: z.object({ closed: z.boolean() }),
  },
  ssh_open: {
    input: z.object({
      target: sshTargetSchema,
      cols: sizeSchema.default(80),
      rows: sizeSchema.default(24),
      /** The saved profile this open belongs to; the session carries it and the profile records the outcome. */
      profileId: z.string().uuid().optional(),
    }),
    output: sessionHandleSchema,
  },
  rdp_open: {
    input: z.object({
      target: rdpTargetSchema,
      width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH).default(1280),
      height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT).default(800),
      profileId: z.string().uuid().optional(),
    }),
    output: sessionHandleSchema,
  },
  rdp_cert_decision: {
    input: sessionHandleSchema.extend({
      fingerprint: z.string().min(1).max(95),
      accept: z.enum(["once", "session_trust", "reject"]),
    }),
    output: z.object({ decided: z.literal(true) }),
  },
  rdp_screenshot: {
    input: sessionHandleSchema,
    output: z.object({
      frameId: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
      timestamp: z.number().int(),
      /** Base64 of the PNG. */
      png: z.string(),
    }),
  },
  profile_list: {
    input: z.null(),
    output: z.array(profileSchema),
  },
  profile_save: {
    input: profileInputSchema,
    output: profileSchema,
  },
  profile_delete: {
    input: z.object({ id: z.string().uuid(), deleteCredential: z.boolean().optional() }),
    output: z.object({ deleted: z.boolean(), credentialDeleted: z.boolean().optional(), credentialError: z.string().optional() }),
  },
  credential_list: {
    input: z.null(),
    output: z.array(credentialViewSchema),
  },
  credential_save: {
    input: z.object({ profileId: z.string().uuid(), secret: z.string().min(1).max(4096) }).strict(),
    output: z.object({ ref: z.string() }),
  },
  credential_update: {
    input: z.object({ ref: z.string().max(96), secret: z.string().min(1).max(4096) }).strict(),
    output: z.object({ updated: z.literal(true) }),
  },
  credential_delete: {
    input: z.object({ ref: z.string().max(96) }).strict(),
    output: z.object({ unlinked: z.number().int() }),
  },
  credential_status: {
    input: z.object({ ref: z.string().max(96) }).strict(),
    output: z.object({ state: z.enum(["present", "missing", "locked", "denied", "unavailable"]) }),
  },
  profile_duplicate: {
    input: z.object({ id: z.string().uuid() }),
    output: profileSchema,
  },
  session_list: {
    input: z.null(),
    output: z.array(sessionInfoSchema),
  },
  session_close: {
    input: sessionHandleSchema,
    output: z.object({ exitCode: z.number().int().nullable(), signal: z.number().int().nullable(), reason: z.string() }),
  },
  session_attach: {
    input: sessionHandleSchema,
    output: z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) }),
  },
};

export type HelperStatus = z.infer<typeof helperStatusSchema>;
export type SessionHandle = z.infer<typeof sessionHandleSchema>;
export type SshTarget = z.infer<typeof sshTargetSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type RdpTarget = z.infer<typeof rdpTargetSchema>;
export type RdpInfo = z.infer<typeof rdpInfoSchema>;
export type RdpCertPromptInfo = z.infer<typeof rdpCertPromptInfoSchema>;
export type RdpDecision = "once" | "session_trust" | "reject";
export { RDP_CLOSED_REASONS };
export type RpcSchemas = typeof rpcSchemas;
