// A failure the user can act on. `code` is stable and safe to show; the
// message never carries tokens, codes or the client secret.
export type DomainErrorCode =
  | "invalid_link"
  | "not_configured"
  | "not_connected"
  | "auth_expired"
  | "auth_denied"
  | "auth_state"
  | "rate_limited"
  | "not_found"
  | "invalid_input"
  | "zoom_error"
  | "network";

export class DomainError extends Error {
  override readonly name = "DomainError";

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
