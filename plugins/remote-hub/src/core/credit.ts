// Host-free per-session credit window. The helper never reads more than the
// granted window of PTY output, and an SSH session starts with zero credit.
// ONE bounded window is owned per session by the service: outstanding
// (granted - acknowledged) never exceeds CREDIT_WINDOW_BYTES. The renderer
// acknowledges consumption from xterm's write callback, and the service
// replenishes only on ack. Snapshot/replay bytes are never acked.

export const CREDIT_WINDOW_BYTES = 262_144;

export interface CreditWindow {
  /** This view became the credit owner; returns bytes to grant now. */
  attach(): number;
  /** The owning view detached; no further acks are honoured. */
  detach(): void;
  /** The renderer acknowledged N bytes; returns bytes to grant to the helper. */
  ack(bytes: number): number;
  readonly outstanding: number;
}

export function createCreditWindow(): CreditWindow {
  let outstanding = 0;
  let everAttached = false;
  let attached = false;
  return {
    attach() {
      attached = true;
      if (!everAttached) {
        everAttached = true;
        outstanding = CREDIT_WINDOW_BYTES;
        return CREDIT_WINDOW_BYTES;
      }
      // Re-attach resumes acking but never adds a second window.
      return 0;
    },
    detach() {
      attached = false;
    },
    ack(bytes) {
      if (!attached || bytes <= 0) return 0;
      outstanding = Math.max(0, outstanding - bytes);
      const replenish = Math.min(bytes, CREDIT_WINDOW_BYTES - outstanding);
      outstanding += replenish;
      return replenish;
    },
    get outstanding() {
      return outstanding;
    },
  };
}
