// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";
import { credentialBindSchema } from "./credential.ts";
import { profileInputSchema, profileSchema } from "./profile.ts";
import { rdpOptionsSchema } from "./rdp-options.ts";

const sourceKindSchema = z.enum(["ssh-config", "hosts", "keys-dir", "agent", "known-hosts"]);
export const importSourceSchema = z.object({
  id: z.string(),
  kind: sourceKindSchema,
  path: z.string().nullable(),
  label: z.string(),
  enabled: z.boolean(),
  useSshG: z.boolean(),
});
const scanItemSchema = z.object({
  key: z.string(),
  name: z.string(),
  action: z.enum(["create", "update", "unchanged", "conflict", "deleted-locally", "skip"]),
  resolved: z.boolean(),
  flags: z.array(z.string()),
  host: z.string(),
  port: z.number().int().nullable(),
  username: z.string().nullable(),
  identityFile: z.string().nullable(),
  skip: z.string().nullable(),
});
export const scanResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ssh-config"), scanId: z.string(), incomplete: z.boolean(), items: z.array(scanItemSchema), stale: z.array(z.string()), issues: z.array(z.string()) }),
  z.object({ kind: z.literal("hosts"), scanId: z.string(), incomplete: z.boolean(), items: z.array(scanItemSchema), stale: z.array(z.string()), issues: z.array(z.string()) }),
  z.object({
    kind: z.literal("known-hosts"),
    scanId: z.string(),
    items: z.array(z.object({ key: z.string(), hosts: z.array(z.string()), hashed: z.boolean(), keyType: z.string(), fingerprint: z.string(), trusted: z.boolean() })),
    issues: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("keys-dir"),
    keys: z.array(z.object({ publicPath: z.string(), privatePath: z.string().nullable(), type: z.string(), comment: z.string(), fingerprint: z.string() })),
    issues: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("agent"),
    keys: z.array(z.object({ type: z.string(), bits: z.number().int(), fingerprint: z.string(), comment: z.string() })),
    issues: z.array(z.string()),
  }),
]);
export const importOutcomeSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  conflicts: z.array(z.string()),
  deletedLocally: z.array(z.string()),
  skipped: z.array(z.string()),
  markedStale: z.number().int(),
});
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
  /** The first use of a saved password: accepting this certificate pins the password to it (stage 3c-2). */
  firstUse: z.boolean().optional(),
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
  /** The thread of the agent that opened the session through remote_connect, when one did. */
  openedByAgent: z.string().nullable().optional(),
});

export const credentialViewSchema = z.object({
  orphaned: z.boolean(),
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
      /** A saved password or key passphrase; the helper's askpass fetches it, it never travels here. */
      credentialRef: z.string().max(200).optional(),
    }),
    output: sessionHandleSchema,
  },
  rdp_open: {
    input: z.object({
      target: rdpTargetSchema,
      width: z.number().int().min(1).max(MAX_DESKTOP_WIDTH).default(1280),
      height: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT).default(800),
      profileId: z.string().uuid().optional(),
      /** Quick connect's quality preset (a closed set). A saved profile's own options win. */
      options: rdpOptionsSchema.optional(),
    }),
    output: sessionHandleSchema,
  },
  rdp_cert_decision: {
    input: sessionHandleSchema.extend({
      fingerprint: z.string().min(1).max(95),
      accept: z.enum(["once", "session_trust", "always_trust", "reject"]),
    }),
    output: z.object({ decided: z.literal(true) }),
  },
  agent_access_list: {
    input: z.object({}).strict(),
    output: z.array(z.object({ profileId: z.string(), level: z.enum(["observe", "input", "exec"]), recordCommands: z.boolean(), updatedAt: z.string() })),
  },
  agent_access_set: {
    input: z.object({ profileId: z.string().uuid(), level: z.enum(["none", "observe", "input", "exec"]), recordCommands: z.boolean() }).strict(),
    output: z.object({ profileId: z.string(), level: z.enum(["none", "observe", "input", "exec"]), recordCommands: z.boolean() }),
  },
  agent_access_revoke_all: { input: z.object({}).strict(), output: z.object({ revoked: z.number().int() }) },
  agent_audit_list: {
    input: z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict(),
    output: z.array(
      z.object({
        id: z.number().int(),
        at: z.string(),
        threadId: z.string(),
        projectId: z.string(),
        tool: z.string(),
        profileId: z.string().nullable(),
        sessionKey: z.string().nullable(),
        detailMode: z.enum(["none", "length", "text"]),
        detail: z.string().nullable(),
        outcome: z.string().nullable(),
        count: z.number().int(),
      }),
    ),
  },
  /** The owner's setting: agents act only while the session is watched (default on). */
  agent_settings_get: { input: z.object({}).strict(), output: z.object({ requireWatching: z.boolean() }) },
  agent_settings_set: { input: z.object({ requireWatching: z.boolean() }).strict(), output: z.object({ requireWatching: z.boolean(), changed: z.boolean() }) },
  agent_control_takeover: {
    input: sessionHandleSchema,
    output: z.object({ tookOver: z.boolean() }),
  },
  /** The owner lets agents drive a session again before the hold after a takeover has run out. */
  agent_control_allow: {
    input: sessionHandleSchema,
    output: z.object({ allowed: z.boolean() }),
  },
  agent_sessions: {
    input: z.object({}).strict(),
    output: z.array(
      z.object({
        generation: z.string(),
        sessionId: z.number().int(),
        kind: z.enum(["echo", "ssh", "rdp"]),
        connectionId: z.string().nullable(),
        state: z.enum(["connecting", "running", "closed"]),
        openedByThread: z.string().nullable(),
        openedByArchivedThread: z.boolean(),
        /** After a takeover agents may not drive it until this time (epoch ms), unless the owner allows it. */
        holdUntil: z.number().nullable(),
        controlledBy: z.enum(["human", "agent"]),
        leaseThreadId: z.string().nullable(),
        leaseExpiresAt: z.number().nullable(),
        questions: z.array(z.object({ kind: z.enum(["host_key", "login_prompt"]), promptId: z.number().int(), text: z.string() })),
        certificate: rdpCertPromptInfoSchema.nullable(),
        /** A person has this session's live view open and visible right now. */
        watching: z.boolean(),
        /** The owner's setting in force: whether an agent needs a watcher to act. */
        watchingRequired: z.boolean(),
      }),
    ),
  },
  agent_prompt_answer: {
    input: sessionHandleSchema.extend({ promptId: z.number().int().min(0), answer: z.string().max(4096).nullable() }),
    output: z.object({ answered: z.literal(true) }),
  },
  rdp_trusted_list: {
    input: z.object({}).strict(),
    output: z.array(z.object({ host: z.string(), port: z.number().int(), fingerprint: z.string(), addedAt: z.string() })),
  },
  rdp_trusted_forget: {
    input: z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535), fingerprint: z.string().min(1).max(95) }).strict(),
    output: z.object({ removed: z.boolean() }),
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
  import_suggestions: {
    input: z.null(),
    output: z.array(z.object({ kind: sourceKindSchema, path: z.string().nullable(), label: z.string() })),
  },
  import_source_list: { input: z.null(), output: z.array(importSourceSchema) },
  import_source_add: {
    input: z.object({ kind: sourceKindSchema, path: z.string().max(1024).nullable(), label: z.string().max(100) }).strict(),
    output: importSourceSchema,
  },
  import_source_set: {
    input: z.object({ id: z.string().max(64), enabled: z.boolean().optional(), useSshG: z.boolean().optional() }).strict(),
    output: importSourceSchema,
  },
  import_source_remove: { input: z.object({ id: z.string().max(64) }).strict(), output: z.object({ removed: z.boolean() }) },
  import_scan: { input: z.object({ id: z.string().max(64) }).strict(), output: scanResultSchema },
  import_apply: {
    input: z.object({ id: z.string().max(64), keys: z.array(z.string().max(256)).max(500).optional(), scanId: z.string().max(64).optional() }).strict(),
    output: importOutcomeSchema,
  },
  import_resolve: {
    input: z.object({ id: z.string().max(64), scanId: z.string().max(64), keys: z.array(z.string().max(256)).max(500) }).strict(),
    output: scanResultSchema,
  },
  known_hosts_list: {
    input: z.null(),
    output: z.array(z.object({ key: z.string(), hosts: z.array(z.string()), hashed: z.boolean(), keyType: z.string(), fingerprint: z.string() })),
  },
  known_hosts_forget: { input: z.object({ host: z.string().min(1).max(255) }).strict(), output: z.object({ removed: z.number().int() }) },
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
export type RdpDecision = "once" | "session_trust" | "always_trust" | "reject";
export { RDP_CLOSED_REASONS };
export type RpcSchemas = typeof rpcSchemas;
