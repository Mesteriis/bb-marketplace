// Fixed error kinds the core raises. Hosts map them to their own transport
// refusals; the message text is always safe to show (never a raw HTTP body,
// a stored value, or a URL path).
export type ErrorKind =
  | "invalid"
  | "not_found"
  | "conflict"
  | "credential_missing"
  | "auth"
  | "network"
  | "http";

export class DomainError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "DomainError";
    this.kind = kind;
  }
}
