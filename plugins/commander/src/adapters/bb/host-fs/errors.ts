import { CommanderError, isCommanderError, type ErrorCode } from "../../../core/errors.ts";

const errnoCodes = new Map<string, ErrorCode>([
  ["ENOENT", "not_found"], ["EEXIST", "already_exists"], ["ENOTEMPTY", "already_exists"],
  ["EACCES", "permission_denied"], ["EPERM", "permission_denied"], ["ELOOP", "permission_denied"],
  ["ENOSPC", "no_space"], ["EROFS", "read_only"], ["ENOTDIR", "not_a_directory"],
  ["EISDIR", "is_a_directory"], ["ENAMETOOLONG", "invalid_name"], ["EXDEV", "unsupported"],
]);

export function hasErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function fsError(error: unknown, signal?: AbortSignal): CommanderError {
  if (isCommanderError(error)) return error;
  if (signal?.aborted) return new CommanderError("cancelled", "Filesystem operation cancelled");
  const errno = error instanceof Error && "code" in error ? error.code : undefined;
  const code = (typeof errno === "string" && errnoCodes.get(errno)) || "internal";
  return new CommanderError(code, "Filesystem operation failed");
}
