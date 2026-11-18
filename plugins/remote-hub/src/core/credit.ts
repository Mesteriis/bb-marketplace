// Host-free per-session credit window (stage 2a). ONE window per session:
// outstanding (granted - consumed) plus the owner view's unacked live bytes
// never exceeds CREDIT_WINDOW_BYTES while a view is attached.
//
// - granted: total credit ever granted to the helper for this session.
// - consumed: total live bytes the service received from the helper.
// - per view: sentLive (live bytes sent to that view since it attached) and
//   acked (live bytes that view acknowledged), acked <= sentLive.
// - owner: the oldest attached view. Only the owner's ack produces a grant.
//   When the owner detaches, the oldest remaining view is promoted.
// - snapshot bytes are not live: they change neither sentLive nor consumed and
//   are never acked.
export const CREDIT_WINDOW_BYTES = 262_144;
/** Per-view bound on unacked live bytes for a NON-owner view: above it
 *  the view is detached (stage 2b). The owner is never detached for
 *  slowness; its backpressure is the intended session stall. */
export const SLOW_VIEW_BYTES = 1_048_576;

interface View {
  sentLive: number;
  acked: number;
}

export interface CreditState {
  attach(viewId: string): number;
  detach(viewId: string): number;
  /** Returns credit to grant to the helper (headless drain only). */
  onConsumed(bytes: number): number;
  /** Output must reach the scrollback with no view attached (agents read without one): grants the first window and arms the drain. */
  startDrain(): number;
  onLiveSent(viewId: string, bytes: number): void;
  ack(viewId: string, bytes: number): number;
  granted(): number;
  consumed(): number;
  outstanding(viewId: string): number;
  size(): number;
  owner(): string | null;
}

export function createCreditState(): CreditState {
  let granted = 0;
  let consumed = 0;
  const views = new Map<string, View>();
  let owner: string | null = null;
  let draining = false;

  const promote = (): string | null => {
    for (const id of views.keys()) {
      owner = id;
      return id;
    }
    owner = null;
    return null;
  };

  const addGrant = (bytes: number): number => {
    if (bytes > 0) granted += bytes;
    return bytes;
  };

  return {
    attach(viewId) {
      const wasEmpty = views.size === 0;
      views.set(viewId, { sentLive: 0, acked: 0 });
      if (wasEmpty) {
        // First attach, or a reattach after every view left: this view becomes
        // the owner and the helper's unconsumed credit is topped back up to one
        // window. For the very first attach that is WINDOW; after a fully acked
        // session it is 0.
        owner = viewId;
        return addGrant(Math.max(0, CREDIT_WINDOW_BYTES - (granted - consumed)));
      }
      if (owner === null) owner = viewId;
      return 0;
    },
    detach(viewId) {
      const wasOwner = owner === viewId;
      views.delete(viewId);
      if (!wasOwner) return 0;
      const newOwner = promote();
      if (newOwner === null) return draining ? addGrant(Math.max(0, CREDIT_WINDOW_BYTES - (granted - consumed))) : 0;
      const v = views.get(newOwner)!;
      const outstanding = v.sentLive - v.acked;
      return addGrant(Math.max(0, CREDIT_WINDOW_BYTES - (granted - consumed) - outstanding));
    },
    onConsumed(bytes) {
      consumed += bytes;
      // With a view attached its acks drive the window (backpressure); with none, the scrollback is the only reader.
      return draining && views.size === 0 ? addGrant(bytes) : 0;
    },
    startDrain() {
      draining = true;
      return addGrant(Math.max(0, CREDIT_WINDOW_BYTES - (granted - consumed)));
    },
    onLiveSent(viewId, bytes) {
      const v = views.get(viewId);
      if (v !== undefined) v.sentLive += bytes;
    },
    ack(viewId, bytes) {
      if (!Number.isInteger(bytes) || bytes <= 0) return 0;
      const v = views.get(viewId);
      if (v === undefined) return 0;
      const clamped = Math.min(bytes, v.sentLive - v.acked);
      if (clamped <= 0) return 0;
      v.acked += clamped;
      if (owner !== viewId) return 0;
      // Grant only the headroom that keeps the invariant, so a promoted owner
      // that has fallen behind cannot push the helper's unconsumed credit past
      // one window.
      const outstanding = v.sentLive - v.acked;
      return addGrant(Math.max(0, CREDIT_WINDOW_BYTES - (granted - consumed) - outstanding));
    },
    granted: () => granted,
    consumed: () => consumed,
    outstanding: (viewId) => {
      const v = views.get(viewId);
      return v === undefined ? 0 : v.sentLive - v.acked;
    },
    size: () => views.size,
    owner: () => owner,
  };
}
