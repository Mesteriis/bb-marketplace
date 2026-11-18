// The Proxmox VE part of the helper stdio protocol (mirror of helper/src/protocol.rs and
// helper/src/pve/protocol.rs) as zod schemas. Host-free; protocol.ts folds these into its unions.
import { z } from "zod";
import { credentialBindSchema } from "./credential-protocol.ts";

const idSchema = z.number().int().min(0);
const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);
const fingerprintSchema = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

/** How the server certificate is trusted; there is no mode that skips verification. */
export const pveTrustWireSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("system") }),
  z.object({ mode: z.literal("ca"), der_hex: z.string().regex(/^([0-9a-f]{2})+$/).max(32768) }),
  z.object({ mode: z.literal("pin"), fingerprint: fingerprintSchema }),
]);
export type PveTrustWire = z.infer<typeof pveTrustWireSchema>;

/** Where a PVE request goes and how it signs in. The secret is in exactly one of `password` (use once)
 *  and `credentialRef` (resolved from the Keychain by the helper). */
export const pveConnectSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    authMode: z.enum(["ticket", "token"]),
    user: z.string().min(1).max(256),
    password: z.string().min(1).max(4096).optional(),
    credentialRef: z.string().min(1).max(96).optional(),
    trust: pveTrustWireSchema,
  })
  .refine((c) => (c.password === undefined) !== (c.credentialRef === undefined), {
    message: "give exactly one of password and credentialRef",
  });
export type PveConnect = z.infer<typeof pveConnectSchema>;

export const pveConsoleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), node: z.string().min(1).max(63) }),
  z.object({ kind: z.literal("lxc"), node: z.string().min(1).max(63), vmid: z.number().int().min(100).max(999_999_999) }),
]);
export type PveConsoleTarget = z.infer<typeof pveConsoleTargetSchema>;

// ---- client -> helper ----
export const openPveRequestSchema = z.object({
  type: z.literal("session.open_pve"),
  id: idSchema,
  connect: pveConnectSchema,
  target: pveConsoleTargetSchema,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  keepaliveSecs: z.number().int().min(1).max(120).optional(),
});
export const pveTargetsRequestSchema = z.object({ type: z.literal("pve.targets"), id: idSchema, connect: pveConnectSchema });

// ---- helper -> client ----
export const pveStateSchema = z.object({ type: z.literal("pve.state"), sessionId: sessionIdSchema, state: z.string().min(1) });
export const pveErrorSchema = z.object({
  type: z.literal("pve.error"),
  sessionId: sessionIdSchema,
  code: z.string().min(1),
  message: z.string(),
  fingerprint: fingerprintSchema.optional(),
});

export const pveNodeSchema = z.object({ node: z.string(), status: z.string() });
export const pveGuestSchema = z.object({
  vmid: z.number().int().min(0),
  name: z.string(),
  kind: z.enum(["qemu", "lxc"]),
  node: z.string(),
  status: z.string(),
  template: z.boolean(),
});
export type PveNode = z.infer<typeof pveNodeSchema>;
export type PveGuest = z.infer<typeof pveGuestSchema>;

export const pveTargetsResultSchema = z.object({
  type: z.literal("pve.targets_result"),
  id: idSchema,
  version: z.string().nullable(),
  nodes: z.array(pveNodeSchema),
  guests: z.array(pveGuestSchema),
});
export const pveFailedSchema = z.object({
  type: z.literal("pve.failed"),
  id: idSchema,
  code: z.string().min(1),
  message: z.string(),
  fingerprint: fingerprintSchema.optional(),
});

/** Closed set of failure codes the helper reports for PVE (helper/src/pve/api.rs `ApiError::code`, plus helper-side ones). */
export const PVE_ERROR_CODES = [
  "login_failed",
  "no_permission",
  "unreachable",
  "timeout",
  "tls_untrusted",
  "cert_changed",
  "tfa_required",
  "api_error",
  "protocol_error",
  "invalid_request",
  "engine_exited",
] as const;
export type PveErrorCode = (typeof PVE_ERROR_CODES)[number];

/** Onboarding mode 1. `connect` is the admin's own login (a password, used once). A dry run only reads and answers
 *  `pve.plan`; an apply names where the created user's password is saved and answers `pve.provisioned`. */
export const pveProvisionRequestSchema = z.object({
  type: z.literal("pve.provision"),
  id: idSchema,
  connect: pveConnectSchema,
  dryRun: z.boolean(),
  aclPath: z.string().min(1).max(80),
  save: z.object({ ref: z.string().min(1).max(96), bind: credentialBindSchema }).optional(),
});

export const PVE_PROVISION_ACTIONS = ["create", "keep", "update", "rotate_password"] as const;
const provisionActionSchema = z.enum(PVE_PROVISION_ACTIONS);
export const pvePlanSchema = z.object({
  type: z.literal("pve.plan"),
  id: idSchema,
  role: provisionActionSchema,
  user: provisionActionSchema,
  acl: provisionActionSchema,
});
export const pveProvisionedSchema = z.object({
  type: z.literal("pve.provisioned"),
  id: idSchema,
  role: provisionActionSchema,
  user: provisionActionSchema,
  acl: provisionActionSchema,
});

/** What mode 1 creates: fixed, and shown to the owner before anything is written. */
export const PVE_PROVISION = { role: "RemoteHubConsole", user: "remotehub@pve", privileges: ["Sys.Audit", "Sys.Console", "VM.Audit", "VM.Console"] } as const;

export const pveRequestSchemas = [openPveRequestSchema, pveTargetsRequestSchema, pveProvisionRequestSchema] as const;
export const pveResponseSchemas = [pveStateSchema, pveErrorSchema, pveTargetsResultSchema, pveFailedSchema, pvePlanSchema, pveProvisionedSchema] as const;
