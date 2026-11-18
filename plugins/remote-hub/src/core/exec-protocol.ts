// Helper wire messages for remote commands (stage 4b-2): one command run with ssh and NO pty. The command is ONE string
// that ssh hands to the remote shell, which parses it; nothing on this machine does (no local shell, no local expansion).
// Mirrors helper/src/protocol.rs (exec.*).
import { z } from "zod";

const idSchema = z.number().int().min(0);
const execIdSchema = z.number().int().min(0).max(0xffff_ffff);

/** The longest remote command line, in UTF-8 bytes (matches helper EXEC_COMMAND_MAX). */
export const EXEC_COMMAND_MAX_BYTES = 8192;
export const EXEC_TIMEOUT_MIN_MS = 1000;
export const EXEC_TIMEOUT_MAX_MS = 600_000;
/** Bytes kept per stream (the head); more is counted and dropped (helper: 1 KiB .. 4 MiB). */
export const EXEC_KEEP_MIN_BYTES = 1024;
export const EXEC_KEEP_MAX_BYTES = 4 * 1024 * 1024;

export const execRunRequestSchema = z.object({
  type: z.literal("exec.run"),
  id: idSchema,
  program: z.string().min(1),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  askpass: z.object({ credentialRef: z.string().min(1).max(96) }).optional(),
  timeoutMs: z.number().int().min(EXEC_TIMEOUT_MIN_MS).max(EXEC_TIMEOUT_MAX_MS),
  maxBytes: z.number().int().min(EXEC_KEEP_MIN_BYTES).max(EXEC_KEEP_MAX_BYTES),
});
export const execReadRequestSchema = z.object({
  type: z.literal("exec.read"),
  id: idSchema,
  execId: execIdSchema,
  stdoutFrom: z.number().int().min(0),
  stderrFrom: z.number().int().min(0),
  max: z.number().int().min(0).max(1 << 20),
});
export const execCancelRequestSchema = z.object({ type: z.literal("exec.cancel"), id: idSchema, execId: execIdSchema });
export const execForgetRequestSchema = z.object({ type: z.literal("exec.forget"), id: idSchema, execId: execIdSchema });

export const execStartedSchema = z.object({ type: z.literal("exec.started"), id: idSchema, execId: execIdSchema });
const chunkSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  /** Base64 of the bytes start..end of what was kept. */
  data: z.string(),
  /** Bytes the stream produced in all, kept or dropped. */
  total: z.number().int().min(0),
  truncated: z.boolean(),
});
export const execStateSchema = z.object({
  type: z.literal("exec.state"),
  id: idSchema,
  execId: execIdSchema,
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  /** exited, timeout, cancelled, output_flood; null while running. */
  reason: z.string().nullable(),
  /** A question ssh asked that was refused: host_key, login_prompt, credential_rejected, credential_unavailable. */
  refused: z.string().nullable(),
  elapsedMs: z.number().int().min(0),
  stdout: chunkSchema,
  stderr: chunkSchema,
});
export const execFinishedSchema = z.object({
  type: z.literal("exec.finished"),
  execId: execIdSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  reason: z.string(),
  refused: z.string().nullable(),
});
export const execForgottenSchema = z.object({ type: z.literal("exec.forgotten"), id: idSchema });

export const execRequestSchemas = [execRunRequestSchema, execReadRequestSchema, execCancelRequestSchema, execForgetRequestSchema] as const;
export const execResponseSchemas = [execStartedSchema, execStateSchema, execFinishedSchema, execForgottenSchema] as const;

export type ExecStateMessage = z.infer<typeof execStateSchema>;
export type ExecFinishedMessage = z.infer<typeof execFinishedSchema>;
