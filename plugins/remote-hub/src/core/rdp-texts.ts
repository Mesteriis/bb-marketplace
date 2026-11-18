// Host-free texts for the RDP page: a sentence for every state, every close
// reason and every error code the service can return, plus the certificate
// validity format. Same plain, lowercase-label tone as the SSH page.

export function stateText(state: string): string {
  switch (state) {
    case "connecting":
      return "connecting";
    case "tls":
      return "securing the connection (TLS)";
    case "cert_prompt":
      return "waiting for your decision on the server certificate";
    case "authenticating":
      return "authenticating";
    case "desktop_ready":
      return "desktop ready";
    case "closed":
      return "closed";
    default:
      return state;
  }
}

const CLOSE_REASONS: Record<string, string> = {
  auth_failed: "sign-in failed: check the user name, password and domain",
  cert_rejected: "the server certificate was rejected",
  cert_changed: "the server certificate is not the one that was expected",
  tls_error: "the secure connection (TLS) could not be set up",
  protocol_error: "the RDP session broke the protocol",
  network_error: "network error: the server is unreachable or the connection dropped",
  timeout: "the connection timed out",
  killed_by_close: "disconnected",
  engine_exited: "the RDP engine stopped unexpectedly",
  helper_shutdown: "the Remote Hub helper shut down",
  helper_exited: "the Remote Hub helper exited",
  server_disconnected: "the server ended the session",
  exited: "the session ended",
};

export function closeReasonText(reason: string | null): string {
  if (reason === null) return "the session ended";
  return CLOSE_REASONS[reason] ?? "closed: " + reason;
}

const ERROR_CODES: Record<string, string> = {
  not_ready: "the desktop is not ready yet",
  session_closed: "the session has ended",
  session_not_found: "the session is gone",
  screenshot_too_large: "the screenshot is too large to send",
  screenshot_busy: "a screenshot is already being taken",
  fingerprint_mismatch: "the decision named a different certificate than the one shown",
  no_pending_prompt: "there is no certificate decision to make",
  rdp_input_overflow: "input is arriving faster than the session takes it; some was dropped",
  rdp_invalid_geometry: "the desktop size is not allowed",
  rdp_open_failed: "the RDP session could not be started",
  response_too_large: "the answer was too large to send",
  bad_control: "the page sent a message the service did not understand",
  protocol_error: "the helper answered out of order",
  helper_exited: "the Remote Hub helper exited",
};

export function errorCodeText(code: string): string {
  return ERROR_CODES[code] ?? code;
}

/** The RPC layer prefixes a helper refusal with its code ("not_ready: …"). */
export function errorTextFromMessage(message: string): string {
  const match = /^([a-z][a-z_]*): /.exec(message);
  if (match !== null && match[1] in ERROR_CODES) return ERROR_CODES[match[1]];
  return message;
}

/** The helper sends certificate validity as epoch seconds; show it as UTC. */
export function formatCertTime(value: string): string {
  if (!/^\d{1,12}$/.test(value)) return value;
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const PROMPT_REASONS: Record<string, string> = {
  untrusted_root: "the certificate is not signed by a root this Mac trusts",
  hostname_mismatch: "the certificate was issued for a different host name",
  expired: "the certificate is expired or not yet valid",
  other: "the certificate could not be validated",
  cert_changed: "this is a DIFFERENT certificate than the one you trusted for this host and port",
};

export function promptReasonText(reason: string): string {
  return PROMPT_REASONS[reason] ?? "the certificate could not be validated (" + reason + ")";
}
