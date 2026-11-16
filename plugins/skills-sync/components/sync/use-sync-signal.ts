import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

/** Channel the backend publishes on after an apply or a background fetch. */
export const SYNC_SIGNAL = "skills-applied";

/**
 * Refetch when the backend says something changed.
 *
 * The signal itself is ephemeral and never replayed, so a signal published
 * while the socket was down is simply lost. Every return to "connected" after
 * the first connect therefore refetches as well: it is the only chance to
 * notice what was missed. The first connect is skipped because the caller's
 * own initial load already covers it.
 *
 * The payload is handed on so a caller can react to one kind of signal more
 * narrowly than to another. A reconnect passes none, which means "anything
 * could have changed" and is the honest answer after a gap.
 */
export function useSyncSignal(refetch: (payload?: unknown) => void): void {
  useRealtime(SYNC_SIGNAL, refetch);

  const state = useRealtimeConnectionState();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const prior = previous.current;
    previous.current = state;
    // Only a transition into "connected" refetches; a `refetch` identity that
    // changed while the connection stayed up must not trigger one.
    if (state !== "connected" || prior === null || prior === "connected") return;
    refetch();
  }, [state, refetch]);
}
