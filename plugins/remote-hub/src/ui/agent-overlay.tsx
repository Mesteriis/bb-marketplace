// The picture and the control for a session an agent is driving (stage 4c: agents are never hidden).
//  - A light animated layer of dots over the widget. It is a picture only: translucent, no blur, no dimming, no pointer
//    events (text can still be selected and read; the service already refuses the human's input while the agent drives,
//    which stays the source of truth), CSS transform/opacity animation only, static under reduced motion.
//  - A label ("Agent is controlling this session", with the agent thread's title when known) and one primary button, "Take
//    control", which uses the owner's existing take-over path. Reachable by keyboard; Escape does nothing.
// It shows exactly while the lease state the page already follows says an agent drives: there is no second source of truth.
// It sits beside the widget (an absolutely positioned sibling), so it changes neither the widget's size nor its on-screen ratio.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SessionHandle } from "../core/rpc.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import type { ControlView } from "./control-banner.tsx";
import { useAgentContext } from "./agent-context.tsx";

/** True while the system asks for reduced motion (a class as well as the media query, so it can be tested and styled). */
export function usePrefersReducedMotion(): boolean {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(query?.matches === true);
  useEffect(() => {
    if (query === null) return;
    const on = (): void => setReduced(query.matches);
    on();
    query.addEventListener?.("change", on);
    return () => query.removeEventListener?.("change", on);
  }, [query]);
  return reduced;
}

export function AgentOverlay(props: { control: ControlView; onTakeover: () => Promise<void>; threadTitle?: ReactNode }) {
  const { control, onTakeover, threadTitle } = props;
  const reduced = usePrefersReducedMotion();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const take = useCallback(() => {
    setBusy(true);
    setFailure(null);
    onTakeover()
      .catch((e: unknown) => setFailure(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  }, [onTakeover]);
  if (control.owner !== "agent") return null;
  return (
    <div className={reduced ? "rh-agent-overlay rh-reduced-motion" : "rh-agent-overlay"} data-testid="agent-overlay">
      <div className="rh-agent-dots" aria-hidden="true" />
      <div className="rh-agent-card" role="group" aria-label="Agent control">
        <span role="status" aria-live="polite" className="rh-agent-label">
          Agent is controlling this session{threadTitle !== undefined && threadTitle !== null ? <> — {threadTitle}</> : null}
        </span>
        {control.blocked && (
          <span role="alert" className="rh-agent-blocked">
            Your input was not sent because an agent is driving this session.
          </span>
        )}
        <button type="button" className="rh-agent-take" onClick={take} disabled={busy}>
          Take control
        </button>
        {failure !== null && (
          <span role="alert" className="rh-error">
            Could not take control: {failure}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The widget with its overlay: a wrapper that lays the overlay over it. `children` is the terminal or desktop wrapper as it
 * was; the overlay appears and goes with `control`.
 */
export function AgentStage(props: { handle: SessionHandle | null; control: ControlView; onTakeover: () => Promise<void>; children: ReactNode }) {
  const ctx = useAgentContext();
  const [thread, setThread] = useState<string | null>(null);
  const agent = props.control.owner === "agent";
  const handle = props.handle;
  const key = handle === null ? null : `${handle.generation}.${handle.sessionId}`;
  useEffect(() => {
    if (!agent || ctx === null || handle === null) {
      setThread(null);
      return;
    }
    let cancelled = false;
    ctx
      .leaseThread(handle)
      .then((t) => !cancelled && setThread(t))
      .catch(() => !cancelled && setThread(null));
    return () => {
      cancelled = true;
    };
    // The lease can change hands: look again when the session or the expiry of the lease changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, key, props.control.expiresAt, ctx]);
  return (
    <div className="rh-agent-stage">
      {props.children}
      <AgentOverlay control={props.control} onTakeover={props.onTakeover} threadTitle={thread !== null && ctx !== null ? ctx.renderThreadTitle(thread) : undefined} />
    </div>
  );
}
