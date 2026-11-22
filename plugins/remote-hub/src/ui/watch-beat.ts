// A live view tells the service it is being looked at (stage 4c: agents are never hidden). "Looked at" means this much and
// no more: the view's element is on screen (at least half of it inside the viewport, seen by an IntersectionObserver),
// the document is visible, and the window has focus. It does NOT prove that a person reads it. A missing document, a
// missing observer or a missing element all count as "not looking": the service then refuses agent actions.
// Host-free: `send` puts one control message on the view's open socket.
export const WATCH_BEAT_MS = 2000;
/** The share of the view that must be inside the viewport. */
export const MIN_VISIBLE_RATIO = 0.5;

export interface WatchEnv {
  document?: Document;
  window?: Window;
  IntersectionObserver?: typeof IntersectionObserver;
}

function globals(): WatchEnv {
  return {
    ...(typeof document === "undefined" ? {} : { document }),
    ...(typeof window === "undefined" ? {} : { window }),
    ...(typeof IntersectionObserver === "undefined" ? {} : { IntersectionObserver }),
  };
}

export function viewExposed(target: Element | null | undefined): boolean {
  if (!target?.isConnected || target.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  for (let node: Element | null = target; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return false;
  }
  return true;
}

export function startWatchBeat(
  send: (message: { type: "watch"; visible: boolean }) => void,
  target: Element | null | undefined,
  env: WatchEnv = globals(),
): () => void {
  const { document: doc, window: win } = env;
  let ratio = 0;
  const looking = (): boolean =>
    doc !== undefined && doc.visibilityState === "visible" && typeof doc.hasFocus === "function" && doc.hasFocus() && ratio >= MIN_VISIBLE_RATIO && viewExposed(target);
  const report = (): void => send({ type: "watch", visible: looking() });

  let observer: IntersectionObserver | null = null;
  if (target !== null && target !== undefined && env.IntersectionObserver !== undefined) {
    observer = new env.IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last === undefined) return;
        ratio = last.isIntersecting ? last.intersectionRatio : 0;
        report();
      },
      { threshold: [0, 0.25, MIN_VISIBLE_RATIO, 0.75, 1] },
    );
    observer.observe(target);
  }
  report();
  const timer = setInterval(report, WATCH_BEAT_MS);
  doc?.addEventListener("visibilitychange", report);
  win?.addEventListener("focus", report);
  win?.addEventListener("blur", report);
  win?.addEventListener("resize", report);
  return () => {
    clearInterval(timer);
    observer?.disconnect();
    doc?.removeEventListener("visibilitychange", report);
    win?.removeEventListener("focus", report);
    win?.removeEventListener("blur", report);
    win?.removeEventListener("resize", report);
  };
}
