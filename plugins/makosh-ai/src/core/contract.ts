import { z } from "zod";

/**
 * Every provider the bridge can route. Adding a provider is one entry here
 * plus Account Pooler support for its `pool` name.
 */
export const providerCatalog = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    apiFormat: "anthropic-messages",
    pool: "claude",
    route: "/v1/messages",
  },
  {
    id: "codex",
    displayName: "Codex",
    apiFormat: "openai-responses",
    pool: "codex",
    route: "/v1/responses",
  },
] as const;
export type ProviderEntry = (typeof providerCatalog)[number];
export type Provider = ProviderEntry["id"];
export const provider = z.enum(
  providerCatalog.map(({ id }) => id) as [Provider, ...Provider[]],
);
export function providerEntry(id: Provider): ProviderEntry {
  const entry = providerCatalog.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown provider: ${id}`);
  return entry;
}

/**
 * Stable machine-readable reasons. A refusal message starts with
 * `<reason>: ` followed by human text; the RPC code stays as before.
 */
export const errorReasons = {
  forbidden_caller: "forbidden",
  bridge_missing: "conflict",
  pool_missing: "not_found",
  busy: "conflict",
  stream_lost: "not_found",
  bad_cursor: "conflict",
  too_large: "invalid",
} as const;
export type ErrorReason = keyof typeof errorReasons;
export type RefusalCode = "conflict" | "forbidden" | "invalid" | "not_found";

export function reasonMessage(reason: ErrorReason, text: string): string {
  return `${reason}: ${text}`;
}

/** Reads the reason prefix of a refusal message, if it has one. */
export function parseReason(message: string): ErrorReason | undefined {
  const match = /^([a-z_]+): /.exec(message);
  return match && Object.hasOwn(errorReasons, match[1]) ? match[1] as ErrorReason : undefined;
}

export const startInput = z.strictObject({
  providerId: provider,
  body: z.record(z.string(), z.json()),
  conversationId: z.string().min(1).max(128).optional(),
  anthropicBeta: z.string().regex(/^[a-zA-Z0-9, -]{1,256}$/).optional(),
}).refine(({ providerId, body, anthropicBeta }) => {
  if (providerId === "claude-code") return true;
  return anthropicBeta === undefined && !body.previous_response_id &&
    !body.conversation && !body.background && !body.store &&
    !(Array.isArray(body.input) && body.input.some((item) =>
      item !== null && typeof item === "object" && "type" in item && item.type === "item_reference"
    ));
}, "Codex calls use caller-supplied history and stateless Responses requests.");

export const handle = z.strictObject({ streamId: z.uuid() });
export const readInput = handle.extend({ cursor: z.number().int().nonnegative() });
export const readOutput = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({
    state: z.literal("chunk"),
    cursor: z.number().int().positive(),
    status: z.number().int(),
    contentType: z.string().nullable(),
    data: z.base64(),
  }),
  z.object({
    state: z.literal("done"),
    status: z.number().int(),
    contentType: z.string().nullable(),
  }),
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
export const cancelOutput = z.object({ cancelled: z.boolean() });

export const poolStart = z.strictObject({ request: startInput, owner: z.string().min(1) });
export const poolRead = readInput.extend({ owner: z.string().min(1) });
export const poolCancel = handle.extend({ owner: z.string().min(1) });

export const modelsInput = z.strictObject({
  providerId: provider,
  projectId: z.string().min(1).optional(),
});
export const modelsOutput = z.object({
  models: z.array(z.object({ model: z.string(), displayName: z.string() })),
});

export const providersInput = z.strictObject({});
export const providerAvailabilityReason = z.enum(["bridge_missing", "pool_missing"]);
export const providersOutput = z.object({
  providers: z.array(z.object({
    id: provider,
    displayName: z.string(),
    apiFormat: z.enum(["anthropic-messages", "openai-responses"]),
    available: z.boolean(),
    reason: providerAvailabilityReason.optional(),
  })),
});
