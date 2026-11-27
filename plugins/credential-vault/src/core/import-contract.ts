import { z } from "zod";

export const onePasswordReference = z.string().trim().max(2048)
  .regex(/^op:\/\/[^/?#\p{Cc}]+\/[^/?#\p{Cc}]+(?:\/[^/?#\p{Cc}]+){1,2}$/u);

export const importTarget = z.object({
  id: z.string().uuid(),
  name: z.string(),
  protocol: z.enum(["ssh", "rdp", "pve"]),
  host: z.string(),
  username: z.string().nullable(),
  revision: z.string(),
  ref: z.string().nullable(),
  shared: z.boolean(),
});

export const importSelection = z.object({
  profileId: z.string().uuid(),
  expectedRevision: z.string().min(1).max(100),
  expectedRef: z.string().max(96).nullable(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("keychain") }).strict(),
    z.object({ kind: z.literal("onepassword"), reference: onePasswordReference, replace: z.boolean() }).strict(),
  ]),
}).strict();

export type ImportTarget = z.infer<typeof importTarget>;
export type ImportSelection = z.infer<typeof importSelection>;
