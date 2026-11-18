// Helper wire messages for saved credentials (stage 3b). The secret goes DOWN in
// `credential.save` only; no response ever carries one (the helper resolves a
// reference itself, in `session.open_rdp` and, in 3b-2, in askpass).
import { z } from "zod";

const idSchema = z.number().int().min(0);
const refSchema = z.string().regex(/^rh-cred:v1:[a-z0-9][a-z0-9-]{0,31}:[0-9a-f-]{36}$/);

/** What a saved secret is for; stored with it in the Keychain and enforced by the helper. */
export const credentialBindSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("endpoint"),
    protocol: z.enum(["ssh", "rdp"]),
    host: z.string(),
    port: z.number().int(),
    user: z.string().nullable(),
    domain: z.string().nullable(),
  }),
  z.object({ type: z.literal("key"), path: z.string() }),
]);

export const credentialSaveRequestSchema = z.object({
  type: z.literal("credential.save"),
  id: idSchema,
  ref: refSchema,
  secret: z.string().min(1).max(4096),
  bind: credentialBindSchema,
});
export const credentialDeleteRequestSchema = z.object({
  type: z.literal("credential.delete"),
  id: idSchema,
  ref: refSchema,
});
export const credentialStatusRequestSchema = z.object({
  type: z.literal("credential.status"),
  id: idSchema,
  ref: refSchema,
});

export const credentialOkSchema = z.object({ type: z.literal("credential.ok"), id: idSchema });
// The answer to `credential.status`; a different type name because the request already owns that one.
export const credentialStatusSchema = z.object({
  type: z.literal("credential.state"),
  id: idSchema,
  present: z.boolean(),
});

export const credentialRequestSchemas = [credentialSaveRequestSchema, credentialDeleteRequestSchema, credentialStatusRequestSchema] as const;
export const credentialResponseSchemas = [credentialOkSchema, credentialStatusSchema] as const;

/** Helper error codes for credential operations. */
export const CREDENTIAL_ERROR_CODES = [
  "keychain_locked",
  "keychain_denied",
  "keychain_unavailable",
  "credential_missing",
  "invalid_credential_ref",
  "invalid_credential_source",
] as const;
