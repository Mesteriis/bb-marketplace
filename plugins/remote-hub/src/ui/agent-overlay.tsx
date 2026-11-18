// The picture and the control for a session an agent is driving (stage 4c: agents are never hidden).
//  - A light layer of dots over the widget, drawn by tsParticles (agent-dots.ts, loaded lazily when a lease first appears) with
//    the static CSS dots as the fallback and under reduced motion. It is a picture only: translucent, no blur, no dimming, no
//    pointer events (text can still be selected and read; the service already refuses the human's input while the agent
//    drives, which stays the source of truth).
//  - A slim bar above the widget: a label ("Agent is controlling this session", with the agent thread's title when known) and one primary button, "Take
//    control", which uses the owner's existing take-over path. Reachable by keyboard; Escape does nothing.
// It shows exactly while the lease state the page already follows says an agent drives: there is no second source of truth.
// The dots are an absolutely positioned sibling of the widget (its size and on-screen ratio are untouched); the bar takes its own
// slim row above the widget while an agent drives.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionHandle } from "../core/rpc.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import type { ControlView } from "./control-banner.tsx";
import { useAgentContext } from "./agent-context.tsx";
import { startDots, type DotsHandle } from "./agent-dots.ts";

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

/** The dots over the widget: a picture only. tsParticles draws them (loaded lazily, never under reduced motion); the static CSS dots are the fallback. */
export function AgentDots({ start = startDots }: { start?: (host: HTMLElement) => Promise<DotsHandle | null> }) {
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (reduced || el === null) return;
    let cancelled = false;
    let handle: DotsHandle | null = null;
    void start(el).then((h) => {
      if (cancelled) {
        h?.destroy();
        return;
      }
      handle = h;
      setLive(h !== null);
    });
    return () => {
      cancelled = true;
      handle?.destroy();
      setLive(false);
    };
  }, [reduced, start]);
  const cls = ["rh-agent-overlay", reduced ? "rh-reduced-motion" : "", live ? "rh-dots-live" : ""].filter((c) => c !== "").join(" ");
  return (
    <div className={cls} data-testid="agent-overlay">
      <div className="rh-agent-dots" aria-hidden="true" ref={host} />
    </div>
  );
}

/** A slim bar above the widget: who drives, and the one button that takes the session back. */
export function AgentBar(props: { control: ControlView; onTakeover: () => Promise<void>; threadTitle?: ReactNode }) {
  const { control, onTakeover, threadTitle } = props;
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
  );
}

/**
 * The widget with its overlay: a wrapper that lays the overlay over it. `children` is the terminal or desktop wrapper as it
 * was; the overlay appears and goes with `control`.
 */
export function AgentStage(props: { handle: SessionHandle | null; control: ControlView; onTakeover: () => Promise<void>; children: ReactNode; startDots?: (host: HTMLElement) => Promise<DotsHandle | null> }) {
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
      <AgentBar control={props.control} onTakeover={props.onTakeover} threadTitle={thread !== null && ctx !== null ? ctx.renderThreadTitle(thread) : undefined} />
      <div className="rh-agent-body">
        {props.children}
        {agent && <AgentDots start={props.startDots} />}
      </div>
    </div>
  );
}
