/// <reference lib="es2024.string" />

import { z } from "zod";

export const ErrorCode = z.enum([
  "invalid_path", "invalid_name", "not_found", "already_exists", "not_a_directory", "is_a_directory",
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
  readonly code: ErrorCode;
  readonly retryable: boolean;

  /** Pass a safe message without underlying provider details or file contents. */
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "CommanderError";
    this.code = code;
    this.retryable = retryable;
  }

  toShape(): CommanderErrorShape {
    const boundary = this.message.slice(MESSAGE_MAX - 1, MESSAGE_MAX + 1);
    const splitsPair = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(boundary);
    const limit = splitsPair ? MESSAGE_MAX - 1 : MESSAGE_MAX;
    return {
      code: this.code,
      message: this.message.slice(0, limit).toWellFormed(),
      retryable: this.retryable,
    };
  }
}

export function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}
