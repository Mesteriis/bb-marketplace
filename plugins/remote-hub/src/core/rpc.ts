// The BB RPC contract for the Remote Hub page, as plain zod schemas.
// server.ts wraps these with the SDK's defineRpcContract.
import { z } from "zod";
import { sessionInputDataSchema } from "./protocol.ts";

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

const sshTargetSchema = z.object({
  host: z.string().min(1),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  configFile: z.string().optional(),
  knownHostsFile: z.string().optional(),
  identityFile: z.string().optional(),
  extraOptions: z.array(z.string()).default([]),
});

export const sessionInfoSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{32}$/),
  sessionId: sessionIdSchema,
  kind: z.enum(["echo", "ssh"]),
  state: z.enum(["connecting", "running", "closed"]),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: z.string().nullable(),
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
    input: z.object({ target: sshTargetSchema, cols: sizeSchema.default(80), rows: sizeSchema.default(24) }),
    output: sessionHandleSchema,
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
    input: sessionHandleSchema,
    output: z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) }),
  },
};

export type HelperStatus = z.infer<typeof helperStatusSchema>;
export type SessionHandle = z.infer<typeof sessionHandleSchema>;
export type SshTarget = z.infer<typeof sshTargetSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type RpcSchemas = typeof rpcSchemas;
