// Why an SFTP channel could not be opened or ended, as one of the contract's stable codes (sftp-contract.ts). The input is
// what the helper reports: a refusal code, or how ssh ended with the head of its stderr. Only the code leaves this module:
// ssh's own text can name a key file or a user and is never passed on. Pure and host-free.
import type { SftpRefusalCode } from "./sftp-contract.ts";
import type { SftpChannelEnd } from "./sftp-protocol.ts";

/** A refusal of `sftp.open` itself (ssh was not started). */
export function classifyOpenRefusal(code: string): SftpRefusalCode {
  switch (code) {
    case "host_key_unknown":
      return "host_key_unknown";
    case "keychain_locked":
      return "keychain_locked";
    case "keychain_needs_approval":
    case "allow_timed_out":
    case "keychain_denied":
      return "keychain_needs_approval";
    case "credential_missing":
    case "credential_unbound":
    case "credential_target_mismatch":
    case "invalid_credential_ref":
      return "credential_missing";
    case "keychain_unavailable":
    case "vault_unavailable":
      return "keychain_unavailable";
    case "ssh_option_rejected":
      return "profile_needs_config";
    case "too_many_channels":
      return "limit_exceeded";
    default:
      return "failure";
  }
}

const UNREACHABLE = [
  "Could not resolve hostname",
  "Connection refused",
  "Connection timed out",
  "Operation timed out",
  "No route to host",
  "Network is unreachable",
  "Connection closed by",
  "Connection reset",
  "kex_exchange_identification",
  "Broken pipe",
];

/**
 * ssh ended before the SFTP version exchange. `agent`: for a connection that signs in with the SSH agent, whether an agent
 * socket is there at all (null for every other kind of sign-in).
 */
export function classifyChannelEnd(end: SftpChannelEnd, agent: "present" | "absent" | null): SftpRefusalCode {
  const text = end.stderr;
  if (text.includes("IDENTIFICATION HAS CHANGED") || text.includes("Host key for") && text.includes("has changed")) return "host_key_changed";
  if (end.refused === "host_key" || text.includes("Host key verification failed") || text.includes("host key is known")) return "host_key_unknown";
  if (end.refused === "credential_unavailable") return "credential_missing";
  const denied = end.refused === "credential_rejected" || end.refused === "login_prompt" || text.includes("Permission denied") || text.includes("Too many authentication failures");
  if (denied) return agent === "absent" ? "agent_unavailable" : "auth_failed";
  if (text.includes("subsystem request failed")) return "profile_not_sftp";
  if (UNREACHABLE.some((needle) => text.includes(needle))) return "unreachable";
  return "failure";
}
