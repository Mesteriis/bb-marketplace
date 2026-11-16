// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";

const sessionIdSchema = z.number().int().min(0).max(0xffff_ffff);
const sizeSchema = z.number().int().min(1).max(10_000);

export const helperStatusSchema = z.object({
  version: z.string().min(1),
  pid: z.number().int().positive(),
  platform: z.string().min(1),
  sessionCount: z.number().int().min(0),
});

export const rpcSchemas = {
  helper_status: {
    input: z.null(),
    output: helperStatusSchema,
  },
  echo_open: {
    input: z.object({ cols: sizeSchema.default(80), rows: sizeSchema.default(24) }),
    output: z.object({ sessionId: sessionIdSchema }),
  },
  echo_input: {
    input: z.object({ sessionId: sessionIdSchema, data: z.string().min(1).max(1_048_576) }),
    output: z.object({ output: z.string(), truncated: z.boolean() }),
  },
  echo_close: {
    input: z.object({ sessionId: sessionIdSchema }),
    output: z.object({ closed: z.boolean() }),
  },
};

export type HelperStatus = z.infer<typeof helperStatusSchema>;
export type RpcSchemas = typeof rpcSchemas;
