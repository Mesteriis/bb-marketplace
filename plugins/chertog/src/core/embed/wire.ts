import { z } from "zod";

export const version = "chertog.embed.v1";
export const providers = ["telegram-chat", "zoom-call", "remote-ssh-live", "remote-rdp-live", "remote-vnc-live"] as const;
export type EmbedType = typeof providers[number];
const provider = z.enum(providers);
const resourceRef = z.uuidv4().regex(/^[0-9a-f-]+$/);
export const paramsSchema = z.strictObject({ resourceRef });
const common = { version: z.literal(version), provider };
const address = { ...common, instanceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), generation: z.number().int().positive() };
export const query = z.strictObject({ ...common, kind: z.literal("query") });
export const host = z.union([
  z.strictObject({ ...address, kind: z.literal("announce"), mode: z.literal("choose") }),
  z.strictObject({ ...address, kind: z.literal("announce"), resourceRef }),
  z.strictObject({ ...address, kind: z.literal("visibility"), visible: z.boolean() }),
  z.strictObject({ ...address, kind: z.enum(["close", "release"]) }),
]);
type WithoutAddress<T> = T extends unknown ? Omit<T, keyof typeof address> : never;
export type HostAction = WithoutAddress<z.infer<typeof host>>;

const owner = z.union([
  z.strictObject({ ...address, kind: z.literal("selected"), resourceRef }),
  z.strictObject({ ...address, kind: z.enum(["choosing", "ready", "denied", "ended", "lost", "revoked", "cancelled", "keep", "hide"]) }),
]);

export function parseOwner(detail: unknown) {
  if (typeof detail === "object" && detail !== null && "version" in detail && detail.version !== version)
    return { ok: false, reason: "unsupported-version" } as const;
  const parsed = owner.safeParse(detail);
  return parsed.success ? { ok: true, message: parsed.data } as const : { ok: false, reason: "invalid-message" } as const;
}
