// Saved connection profiles (stage 3a): the data model, host-free.
//
// A profile is metadata only. It never holds a password, a passphrase or key
// material: the schemas are strict, so a secret-shaped field is refused, and
// the only link to a secret is `credentialRef`, an opaque reference that names
// the execution host it is valid on (stage 3b resolves it).
import { z } from "zod";
import { assertHostToken } from "./ssh-args.ts";

/** The only execution host there is until a remote one exists. */
export const LOCAL_EXECUTION_HOST_ID = "local";

const CREDENTIAL_REF = /^rh-cred:v1:([a-z0-9][a-z0-9-]{0,31}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** A reference of the form rh-cred:v1:<executionHostId>:<uuid>, or null. */
export function parseCredentialRef(ref: string): { executionHostId: string; id: string } | null {
  const match = CREDENTIAL_REF.exec(ref);
  if (match === null) return null;
  return { executionHostId: match[1] as string, id: match[2] as string };
}

const credentialRefSchema = z.string().refine((value) => parseCredentialRef(value) !== null, {
  message: "credentialRef must be an rh-cred:v1:<executionHostId>:<uuid> reference",
});

const hostSchema = z
  .string()
  .max(255)
  .refine(
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

const nameSchema = z.string().trim().min(1).max(100);
const groupSchema = z.string().trim().min(1).max(60);
const tagSchema = z.string().trim().min(1).max(32);

const tagsSchema = z
  .array(tagSchema)
  .max(20)
  .transform((tags) => [...new Set(tags)])
  .refine((tags) => tags.length <= 20);

const absolutePathSchema = z
  .string()
  .max(1024)
  .refine((path) => path.startsWith("/") && !/[\x00-\x1f\x7f-\x9f]/.test(path), {
    message: "identityFile must be an absolute path",
  });

/** The editable part of a profile. Strict: unknown keys (password, ...) are refused. */
export const profileFieldsSchema = z
  .object({
    name: nameSchema,
    protocol: z.enum(["ssh", "rdp"]),
    group: groupSchema.nullable(),
    tags: tagsSchema,
    favorite: z.boolean(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable(),
    host: hostSchema,
    /** null = the protocol's default port. */
    port: z.number().int().min(1).max(65535).nullable(),
    username: z.string().trim().min(1).max(256).nullable(),
    /** RDP only. */
    domain: z.string().trim().min(1).max(256).nullable(),
    authType: z.enum(["agent", "key", "password"]),
    /** SSH key file path (a path, not key material); key auth only. */
    identityFile: absolutePathSchema.nullable(),
    credentialRef: credentialRefSchema.nullable(),
    /** RDP desktop size; null = the page default. */
    rdpWidth: z.number().int().min(1).max(3840).nullable(),
    rdpHeight: z.number().int().min(1).max(2160).nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (p.protocol === "rdp") {
      if (p.username === null) issue("username", "an RDP profile needs a username");
      if (p.authType !== "password") issue("authType", "an RDP profile signs in with a password");
      if (p.identityFile !== null) issue("identityFile", "an RDP profile has no key file");
      if ((p.rdpWidth === null) !== (p.rdpHeight === null)) issue("rdpWidth", "set both desktop width and height or neither");
    } else {
      if (p.domain !== null) issue("domain", "only an RDP profile has a domain");
      if (p.rdpWidth !== null || p.rdpHeight !== null) issue("rdpWidth", "only an RDP profile has a desktop size");
      if (p.authType === "key" && p.identityFile === null) issue("identityFile", "key authentication needs a key file");
      if (p.authType !== "key" && p.identityFile !== null) issue("identityFile", "a key file belongs to key authentication");
    }
  });

/** What the page sends to save: the fields, plus the id when it updates. */
export const profileInputSchema = z.object({ id: z.string().uuid().optional(), fields: profileFieldsSchema });

const recentErrorSchema = z.object({ at: z.string(), code: z.string().min(1).max(64) }).strict();

/** A stored profile as the page sees it. */
export const profileSchema = z
  .object({
    id: z.string().uuid(),
    executionHostId: z.string().min(1).max(32),
    /** Where the profile came from; imports (stage 3c) add values. */
    origin: z.enum(["manual"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** When a session was last opened from it: the open call succeeded, not that the server accepted a login. */
    lastOpenedAt: z.string().nullable(),
    /** Failure codes of recent opens, newest last, never message text. */
    recentErrors: z.array(recentErrorSchema).max(5),
  })
  .strict()
  .and(profileFieldsSchema)
  .superRefine((p, ctx) => {
    if (p.credentialRef === null) return;
    const ref = parseCredentialRef(p.credentialRef);
    if (ref !== null && ref.executionHostId !== p.executionHostId) {
      ctx.addIssue({ code: "custom", path: ["credentialRef"], message: "credentialRef belongs to another execution host" });
    }
  });

export type ProfileFields = z.infer<typeof profileFieldsSchema>;
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** The editable fields of a stored profile (what the editor starts from). */
export function profileFieldsOf(p: Profile): ProfileFields {
  return {
    name: p.name,
    protocol: p.protocol,
    group: p.group,
    tags: p.tags,
    favorite: p.favorite,
    color: p.color,
    host: p.host,
    port: p.port,
    username: p.username,
    domain: p.domain,
    authType: p.authType,
    identityFile: p.identityFile,
    credentialRef: p.credentialRef,
    rdpWidth: p.rdpWidth,
    rdpHeight: p.rdpHeight,
  };
}
