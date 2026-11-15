// IMAP IDLE policy (slice 3e): how a watch ends, when the supervisor tries
// again, and how long it waits before waking an Inbox round. Pure; the
// adapter watches and the supervisor schedules.

/** How a watch of one folder ended. "reset" is gone (spec resolution 25). */
export type WatchEnd =
  | { kind: "aborted" }
  /** The server has no IDLE capability. */
  | { kind: "unsupported" }
  /** The login was refused. */
  | { kind: "auth" }
  /** A transient login refusal (too many connections). */
  | { kind: "throttled" }
  /** The server or the network ended it; a safe code only. */
  | { kind: "dropped"; code: string };

/** The code of a watch whose IDLE the server answered with NO or BAD (spec resolution 15). */
export const IDLE_REFUSED_CODE = "IdleRefused";

/** Waits before reconnecting, by consecutive failure; the last repeats. */
export const IDLE_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000, 900_000];
/** A watch that lasted this long resets the backoff. */
export const IDLE_STABLE_MS = 600_000;
/** After a throttled login. */
export const IDLE_THROTTLED_MS = 900_000;
/** Debounce of the Inbox round per change kind. */
export const IDLE_DEBOUNCE_MS = { exists: 1_000, expunge: 30_000, flags: 30_000 } as const;
/** A quiet socket while idling sends a recovery NOOP after this (spec resolution 15). */
export const IDLE_SOCKET_TIMEOUT_MS = 75_000;
/** Upper bound of one IDLE command before it is restarted. */
export const IDLE_RESTART_MS = 20 * 60_000;

export type IdleState = { attempt: number; lastStartedAt: number | null };
export type IdleStep = { kind: "retry"; delayMs: number; attempt: number } | { kind: "stop"; wakeFull: boolean };

/**
 * What the supervisor does after a watch ended. A refused login stops the
 * watch and wakes a full round, which records the refusal; the watch never
 * retries a login by itself.
 */
export function nextIdleStep(state: IdleState, end: WatchEnd, now: number): IdleStep {
  switch (end.kind) {
    case "aborted":
    case "unsupported":
      return { kind: "stop", wakeFull: false };
    case "auth":
      return { kind: "stop", wakeFull: true };
    case "throttled":
      return { kind: "retry", delayMs: IDLE_THROTTLED_MS, attempt: Math.max(state.attempt + 1, IDLE_BACKOFF_MS.length) };
    case "dropped": {
      const stable = state.lastStartedAt !== null && now - state.lastStartedAt >= IDLE_STABLE_MS;
      const attempt = stable ? 0 : state.attempt;
      const delayMs = IDLE_BACKOFF_MS[Math.min(attempt, IDLE_BACKOFF_MS.length - 1)] as number;
      return { kind: "retry", delayMs, attempt: attempt + 1 };
    }
  }
}
