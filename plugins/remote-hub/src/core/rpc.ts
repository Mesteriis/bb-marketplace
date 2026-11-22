// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";
import { credentialBindSchema } from "./credential.ts";
import { profileInputSchema, profileSchema } from "./profile.ts";
import { rdpOptionsSchema } from "./rdp-options.ts";
import { PVE_OUTCOMES } from "./pve-targets.ts";
import { PVE_ACL_ACTIONS, PVE_ROLE_ACTIONS, PVE_USER_ACTIONS, pveNodeSchema, pvePlanExtrasSchema, pveStepsSchema } from "./pve-protocol.ts";
import { pveProfileTrustSchema } from "./pve-trust.ts";

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
  checksum: z.enum(["verified", "not_checked"]),
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

export const pveConsoleInfoSchema = z.object({
  profileId: z.string(),
  connectionName: z.string(),
  console: z.enum(["node", "lxc", "qemu"]),
  node: z.string(),
  vmid: z.number().int().nullable(),
  guestName: z.string().nullable(),
  state: z.enum(["connecting", "active", "lost", "disconnected", "error"]),
  /** Why a console failed or was lost: fixed local text, never a server body. */
  reason: z.object({ code: z.string(), text: z.string(), fingerprint: z.string().nullable() }).nullable(),
  /** When the console became active and when it ended (ms since the epoch): how long it really held. */
  activeAt: z.number().nullable().optional(),
  endedAt: z.number().nullable().optional(),
});

export const pveConsoleTabSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  console: z.enum(["node", "lxc", "qemu"]),
  node: z.string().min(1).max(63).nullable(),
  vmid: z.number().int().min(100).max(999_999_999).nullable(),
  title: z.string().max(120),
});

export type PveConsoleTabRow = z.infer<typeof pveConsoleTabSchema>;

export const sessionInfoSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{32}$/),
  sessionId: sessionIdSchema,
  kind: z.enum(["echo", "ssh", "rdp", "pve", "vnc"]),
  state: z.enum(["connecting", "running", "closed"]),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: z.string().nullable(),
  rdp: rdpInfoSchema.optional(),
  /** A Proxmox console (kind pve or vnc): its target, state and failure reason. */
  pve: pveConsoleInfoSchema.optional(),
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

const pveGuestViewSchema = z.object({
  /** profile id + VMID: the identity of a guest. */
  key: z.string(),
  profileId: z.string(),
  vmid: z.number().int(),
  name: z.string(),
  kind: z.enum(["qemu", "lxc"]),
  node: z.string(),
  status: z.string(),
  template: z.boolean(),
  console: z.object({ available: z.boolean(), reason: z.string().nullable() }),
  linkedProfileId: z.string().nullable(),
});
export const pveConnectionViewSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  credentialRef: z.string().nullable(),
  outcome: z.enum(PVE_OUTCOMES),
  message: z.string().nullable(),
  fingerprint: z.string().nullable(),
  version: z.string().nullable(),
  nodes: z.array(pveNodeSchema),
  guests: z.array(pveGuestViewSchema),
  fetchedAt: z.string().nullable(),
  stale: z.object({ ageSeconds: z.number().int() }).nullable(),
});

const pveEndpointSchema = z.object({
  host: rdpHostSchema,
  port: z.number().int().min(1).max(65535).default(8006),
  /** null = the system roots. */
  trust: pveProfileTrustSchema.nullable().default(null),
});
const pveAdminSchema = pveEndpointSchema.extend({
  /** The administrator's own login: supplied for this setup (plan and apply each sign in) and never stored. */
  adminUser: z.string().min(1).max(256),
  adminPassword: z.string().min(1).max(1024),
  aclPath: z.string().min(1).max(80).default("/"),
  /** The managed user, name@pve; the realm is fixed. */
  userId: z.string().regex(/^[A-Za-z0-9._-]{1,32}@pve$/).default("remotehub@pve"),
});
const pveFailureSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  fingerprint: z.string().nullable(),
  /** What each step of an apply did, when it got that far. */
  steps: pveStepsSchema.nullable(),
  /** A connection kept after a partial failure (it is flagged "setup incomplete"). */
  profileId: z.string().optional(),
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
  /** Every Proxmox connection (or the named ones), each with its own outcome; one failing never hides the rest. */
  pve_targets: {
    input: z.object({ profileIds: z.array(z.string().uuid()).max(200).optional(), refresh: z.boolean().default(false) }).strict(),
    output: z.object({ connections: z.array(pveConnectionViewSchema) }),
  },
  /** The owner confirmed the certificate a refusal showed: trust that exact one for this connection. */
  pve_trust_pin: {
    input: z.object({ profileId: z.string().uuid(), fingerprint: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) }).strict(),
    output: z.object({ pinned: z.literal(true) }),
  },
  /** Link (or unlink with null) a guest to a saved SSH/RDP profile; the owner's choice, never a guessed address. */
  pve_guest_link_set: {
    input: z.object({ profileId: z.string().uuid(), vmid: z.number().int().min(100).max(999_999_999), linkProfileId: z.string().uuid().nullable() }).strict(),
    output: z.object({ linked: z.boolean() }),
  },
  /**
   * Opens a console of a saved Proxmox connection: a node shell or one guest's console, as a session. The guest's node is looked
   * up again first; a stopped guest or a template is refused with its reason (nothing is started).
   */
  pve_console_open: {
    input: z
      .object({
        profileId: z.string().uuid(),
        console: z.enum(["node", "lxc", "qemu"]),
        node: z.string().min(1).max(63).optional(),
        vmid: z.number().int().min(100).max(999_999_999).optional(),
        cols: sizeSchema.default(80),
        rows: sizeSchema.default(24),
      })
      .strict()
      .refine((i) => (i.console === "node" ? i.node !== undefined && i.vmid === undefined : i.vmid !== undefined && i.node === undefined), { message: "a node shell names its node; a guest console names its VMID" }),
    output: z.union([
      z.object({ ok: z.literal(true), generation: z.string().regex(/^[0-9a-f]{32}$/), sessionId: sessionIdSchema, kind: z.enum(["pve", "vnc"]), node: z.string() }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string(), fingerprint: z.string().nullable() }),
    ]),
  },
  /** The console tabs the owner had open (targets only): restored after a restart as "not connected", never as live. */
  pve_console_tabs_list: {
    input: z.object({}).strict(),
    output: z.object({ tabs: z.array(pveConsoleTabSchema) }),
  },
  pve_console_tab_put: {
    input: pveConsoleTabSchema.strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  pve_console_tab_remove: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  /** Mode 1, step 1: what would be created, what the user already holds, and the digest of the state the plan was computed from. Reads only. */
  pve_onboard_plan: {
    input: pveAdminSchema.strict(),
    output: z.union([
      z.object({
        ok: z.literal(true),
        role: z.enum(PVE_ROLE_ACTIONS),
        user: z.enum(PVE_USER_ACTIONS),
        acl: z.enum(PVE_ACL_ACTIONS),
        userId: z.string(),
        rolePrivs: z.string().nullable(),
        extras: pvePlanExtrasSchema,
        digest: z.string(),
      }),
      pveFailureSchema,
    ]),
  },
  /** Mode 1, step 2, for the plan the owner confirmed (its digest). Creates what is missing and saves the new password in the Keychain. */
  pve_onboard_apply: {
    input: pveAdminSchema.extend({ name: z.string().trim().min(1).max(100), planDigest: z.string().regex(/^[0-9a-f]{64}$/), replaceRole: z.boolean().default(false) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), profileId: z.string(), userId: z.string(), steps: pveStepsSchema }), pveFailureSchema]),
  },
  /** Mode 2: connect as is; the secret is saved for this connection only and nothing is created in Proxmox. */
  pve_onboard_connect: {
    input: pveEndpointSchema.extend({ name: z.string().trim().min(1).max(100), authMode: z.enum(["ticket", "token"]), user: z.string().min(1).max(256), secret: z.string().min(1).max(4096) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), profileId: z.string() }), z.object({ ok: z.literal(false), code: z.string(), message: z.string() })]),
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
        kind: z.enum(["echo", "ssh", "rdp", "pve", "vnc"]),
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
    output: z.object({ state: z.enum(["present", "missing", "locked", "needs_approval", "denied", "unavailable"]) }),
  },
  /**
   * The owner's "Allow access" for one saved credential: one read in the short-lived keychain child with macOS allowed to ask
   * (its own dialog, "Always Allow"). Owner only; never an agent tool, never automatic.
   */
  credential_allow: {
    input: z.object({ ref: z.string().max(96) }).strict(),
    output: z.object({ state: z.enum(["present", "missing", "locked", "needs_approval", "denied", "unavailable"]) }),
  },
  /** The same for every saved credential, one by one (each shows macOS's own prompt); stops at a locked Keychain. */
  credential_allow_all: {
    input: z.object({}).strict(),
    output: z.object({ results: z.array(z.object({ ref: z.string(), label: z.string(), ok: z.boolean(), code: z.string().nullable() })) }),
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
    input: sessionHandleSchema.extend({ liveKind: z.enum(["ssh", "rdp", "vnc"]).optional() }),
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
