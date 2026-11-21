// Wire contract between the page and the backend: plain zod schemas. A host
// wraps them for its own transport (BB RPC today).
import { z } from "zod";

export const meetingSchema = z
  .object({
    id: z.string(),
    topic: z.string(),
    startTime: z.string().nullable(),
    durationMinutes: z.number(),
    joinUrl: z.string(),
    passcode: z.string().nullable(),
  })
  .strict();

export const statusSchema = z
  .object({
    /** Client ID and Client Secret are both set. */
    configured: z.boolean(),
    connected: z.boolean(),
    displayName: z.string().nullable(),
  })
  .strict();

export const preparedCallSchema = z
  .object({
    meetingNumber: z.string(),
    passcode: z.string().nullable(),
    userName: z.string(),
    signature: z.string(),
    zak: z.string(),
    fallbackUrl: z.string(),
  })
  .strict();

const ok = z.object({ ok: z.literal(true) }).strict();

export const rpcSchemas = {
  status: { input: z.null(), output: statusSchema },
  login_begin: {
    input: z.object({ origin: z.string().max(2048) }).strict(),
    output: z.object({ authorizeUrl: z.string(), redirectUri: z.string() }).strict(),
  },
  redirect_uri: {
    input: z.object({ origin: z.string().max(2048) }).strict(),
    output: z.object({ redirectUri: z.string() }).strict(),
  },
  disconnect: { input: z.null(), output: ok },
  meetings_list: { input: z.null(), output: z.object({ meetings: z.array(meetingSchema) }).strict() },
  meeting_create: {
    input: z
      .object({
        topic: z.string().max(1000),
        startTime: z.string().max(64).nullable(),
        durationMinutes: z.number(),
        timeZone: z.string().max(64),
      })
      .strict(),
    output: z.object({ meeting: meetingSchema }).strict(),
  },
  call_open_external: {
    input: z.object({ link: z.string().max(2048), asHost: z.boolean() }).strict(),
    output: z.object({ url: z.string(), opened: z.boolean() }).strict(),
  },
  call_prepare: {
    input: z.object({ link: z.string().max(2048), asHost: z.boolean() }).strict(),
    output: preparedCallSchema,
  },
} as const;

/** Realtime channel: the account was connected or disconnected. */
export const CHANNEL_ACCOUNT_CHANGED = "account.changed";
