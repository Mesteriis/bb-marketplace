// When and how a lost terminal console is opened again (host-free).
//  - 5 attempts, waiting 1, 2, 4, 8 and 16 seconds before them, each wait jittered by up to 25% either way.
//  - Only for a console that was lost without anyone's decision (the other side closed, the websocket broke, the endpoint did not
//    answer, the engine or helper ended). Never after Disconnect, the idle close, a login or permission refusal, a certificate
//    refusal, a second-factor account, a stopped guest or any other answer that repeating cannot change: those stop at once,
//    because retrying a refused login can lock the account.
//  - An attempt is a whole new open (fresh login, fresh guest location, fresh console ticket, new websocket); what was typed
//    before the loss is never replayed.
export const RECONNECT_ATTEMPTS = 5;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_JITTER = 0.25;

/** Reasons (an end reason or an open refusal) after which another attempt can succeed. */
const RETRYABLE: ReadonlySet<string> = new Set([
  "remote_closed",
  "upstream_stalled",
  "websocket_error",
  "engine_exited",
  "helper_exited",
  "protocol_error",
  "unreachable",
  "timeout",
  "api_error",
  "node_offline",
  "open_failed",
]);

export function isRetryable(code: string): boolean {
  return RETRYABLE.has(code);
}

/** Wait before attempt `attempt` (1-based): 1, 2, 4, 8, 16 s, jittered. `random` is in [0, 1). */
export function delayBefore(attempt: number, random: number): number {
  const base = RECONNECT_BASE_MS * 2 ** (Math.max(1, attempt) - 1);
  return Math.round(base * (1 + RECONNECT_JITTER * (2 * random - 1)));
}

/** The line written into a console's scrollback where its connection was lost. */
export const LOST_SEPARATOR = "\r\n\u001b[33m──── connection lost ────\u001b[0m\r\n";
export const RECONNECTED_SEPARATOR = "\r\n\u001b[33m──── reconnected: a new console, nothing typed before is sent again ────\u001b[0m\r\n";

export type ReconnectDecision = { action: "wait"; attempt: number; delayMs: number } | { action: "stop"; why: "not_retryable" | "gave_up" };

/**
 * What to do after a loss or a failed attempt with reason `code`, when `made` attempts have been made in this episode (0 right
 * after the loss). `random` is in [0, 1).
 */
export function decideReconnect(made: number, code: string, random: number): ReconnectDecision {
  if (!isRetryable(code)) return { action: "stop", why: "not_retryable" };
  const next = made + 1;
  if (next > RECONNECT_ATTEMPTS) return { action: "stop", why: "gave_up" };
  return { action: "wait", attempt: next, delayMs: delayBefore(next, random) };
}

/** An attempt that held up for this long counts as a new connection: the next loss starts a fresh episode of attempts. */
export const STABLE_AFTER_MS = 10_000;
