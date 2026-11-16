// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";

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
    input: sessionHandleSchema.extend({ data: z.string().min(1).max(1_048_576) }),
    output: z.object({ output: z.string(), truncated: z.boolean() }),
  },
  echo_close: {
    input: sessionHandleSchema,
    output: z.object({ closed: z.boolean() }),
  },
};

export type HelperStatus = z.infer<typeof helperStatusSchema>;
export type SessionHandle = z.infer<typeof sessionHandleSchema>;
export type RpcSchemas = typeof rpcSchemas;
