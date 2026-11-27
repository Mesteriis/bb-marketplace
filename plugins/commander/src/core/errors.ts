import { z } from "zod";

export const ErrorCode = z.enum([
  "invalid_path", "not_found", "already_exists", "not_a_directory", "is_a_directory",
  "permission_denied", "read_only", "no_space", "changed_since_plan",
  "connection_failed", "host_key_rejected", "auth_failed", "consent_required",
  "cancelled", "timeout", "unsupported", "limit_exceeded", "outcome_unknown", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const MESSAGE_MAX = 500;

export const CommanderErrorShape = z.object({
  code: ErrorCode,
  message: z.string().max(MESSAGE_MAX),
  retryable: z.boolean(),
}).strict();
export type CommanderErrorShape = z.infer<typeof CommanderErrorShape>;

export class CommanderError extends Error {
  /** Pass a safe message without underlying provider details or file contents. */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CommanderError";
  }

  toShape(): CommanderErrorShape {
    return {
      code: this.code,
      message: this.message.slice(0, MESSAGE_MAX),
      retryable: this.retryable,
    };
  }
}

export function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}
