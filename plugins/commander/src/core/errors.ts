/// <reference lib="es2024.string" />

import { z } from "zod";

export const ErrorCode = z.enum([
  "invalid_path", "invalid_name", "not_found", "already_exists", "not_a_directory", "is_a_directory",
  "permission_denied", "read_only", "no_space", "changed_since_plan",
  "connection_failed", "host_key_rejected", "auth_failed", "consent_required",
  "cancelled", "timeout", "unsupported", "limit_exceeded", "outcome_unknown", "internal",
  "invalid_archive",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Closed reason set per code (S14 archives). A reason is valid only under its own code. */
export const ERROR_REASONS = {
  invalid_archive: [
    "bad_tar", "bad_zip", "bad_eocd", "bad_zip64", "bad_range", "bad_pax", "count_mismatch", "scan_mismatch",
    "overlapping_entries", "local_name_mismatch", "multi_volume", "truncated", "size_overflow", "duplicate_name",
    "crc_mismatch", "size_mismatch", "aes_auth_failed", "name_collision",
  ],
  limit_exceeded: [
    "meta_too_large", "directory_too_large", "too_many_entries", "name_too_long", "ratio", "total_bytes",
    "too_many_open_archives", "too_many_streams",
  ],
  auth_failed: ["password_required", "bad_password"],
  consent_required: ["archive_copy"],
  unsupported: [
    "link_not_supported", "link_escapes", "encryption_unsupported", "v7_tar", "pax_size", "unsupported_format",
    "unsupported_compression", "archives_unavailable",
  ],
  internal: ["helper_checksum_failed", "helper_version_mismatch", "helper_crashed", "protocol_error"],
} as const satisfies Partial<Record<ErrorCode, readonly string[]>>;

export const ErrorReason = z.enum([
  ...ERROR_REASONS.invalid_archive, ...ERROR_REASONS.limit_exceeded, ...ERROR_REASONS.auth_failed,
  ...ERROR_REASONS.unsupported, ...ERROR_REASONS.internal, ...ERROR_REASONS.consent_required,
]);
export type ErrorReason = z.infer<typeof ErrorReason>;

function reasonAllowed(code: ErrorCode, reason: ErrorReason): boolean {
  const allowed = (ERROR_REASONS as Partial<Record<ErrorCode, readonly string[]>>)[code];
  return allowed?.includes(reason) ?? false;
}

const MESSAGE_MAX = 500;

export const CommanderErrorShape = z.object({
  code: ErrorCode,
  message: z.string().max(MESSAGE_MAX),
  retryable: z.boolean(),
  reason: ErrorReason.optional(),
}).strict().superRefine((shape, ctx) => {
  if (shape.reason !== undefined && !reasonAllowed(shape.code, shape.reason)) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is not allowed for this code" });
  }
});
export type CommanderErrorShape = z.infer<typeof CommanderErrorShape>;

export class CommanderError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly reason: ErrorReason | undefined;

  /** Pass a safe message without underlying provider details or file contents. */
  constructor(code: ErrorCode, message: string, retryable = false, reason?: ErrorReason) {
    super(message);
    this.name = "CommanderError";
    this.code = code;
    this.retryable = retryable;
    this.reason = reason;
  }

  toShape(): CommanderErrorShape {
    const boundary = this.message.slice(MESSAGE_MAX - 1, MESSAGE_MAX + 1);
    const splitsPair = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(boundary);
    const limit = splitsPair ? MESSAGE_MAX - 1 : MESSAGE_MAX;
    return {
      code: this.code,
      message: this.message.slice(0, limit).toWellFormed(),
      retryable: this.retryable,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }
}

export function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}
