// A live view tells the service it is being looked at (stage 4c: agents are never hidden). Visible and reporting is what
// lets an agent type into the session or run a command on it; a hidden page, a closed view or a stalled one is not.
// Host-free: `send` puts one control message on the view's open socket.
export const WATCH_BEAT_MS = 2000;

export function startWatchBeat(send: (message: { type: "watch"; visible: boolean }) => void): () => void {
  const report = (): void => send({ type: "watch", visible: typeof document === "undefined" || document.visibilityState !== "hidden" });
  report();
  const timer = setInterval(report, WATCH_BEAT_MS);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", report);
  return () => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", report);
  };
}
