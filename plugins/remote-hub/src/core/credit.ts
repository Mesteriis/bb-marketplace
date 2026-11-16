// Host-free per-socket credit window for an SSH session. The helper never reads
// more than the granted window of PTY output, and an SSH session starts with
// zero credit. The adapter owns one window per attached socket: it grants an
// initial 256 KiB on attach and replenishes exactly the bytes it forwards to
// the renderer, so a bounded window is always in flight while attached and
// nothing is granted while detached.

export const CREDIT_WINDOW_BYTES = 262_144;

export interface CreditController {
  /** Mark the socket attached; returns the initial credit grant in bytes. */
  attach(): number;
  /** Mark the socket detached; no further grants are issued. */
  detach(): void;
  /** Account for bytes forwarded to the renderer; returns bytes to replenish. */
  consumed(bytes: number): number;
}

export function createCreditController(): CreditController {
  let attached = false;
  return {
    attach() {
      attached = true;
      return CREDIT_WINDOW_BYTES;
    },
    detach() {
      attached = false;
    },
    consumed(bytes) {
      if (!attached || bytes <= 0) return 0;
      return bytes;
    },
  };
}
