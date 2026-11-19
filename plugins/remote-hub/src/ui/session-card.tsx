// What a `::remote-session{id="…"}` directive in an agent's reply shows: a CARD, never a live view. The id is text an agent
// wrote, so it only selects which session to describe (and is refused unless it is `generation.number`); the thread to put
// in the split comes from the service's own record of who opened or holds the session, never from the directive.
// Nothing attaches here: watching happens in the page or the split the owner opens with one of the two buttons.
import { useEffect, useRef, useState } from "react";
import type { SessionHandle } from "../core/rpc.ts";
import type { AgentSessionView } from "./agent-panel.tsx";
import { parseSessionKey } from "./session-key.ts";
import { agentThreadOf, type SplitOutcome } from "./split-watch.ts";

export interface SessionCardApi {
  /** The owner-only record of this session, or null when it is not open. */
  describe: (handle: SessionHandle) => Promise<AgentSessionView | null>;
  /** The live view in the main pane and the agent's thread in a split beside it. */
  watchInSplit: (sessionKey: string, agentThread: string | null) => Promise<SplitOutcome>;
  /** The plugin page on this session. */
  open: (sessionKey: string) => void;
  /** The agent's thread on its own (the way back when splits are off). */
  openThread: (threadId: string) => void;
}

export function SessionCard({ sessionKey, api }: { sessionKey: string; api: SessionCardApi }) {
  const handle = parseSessionKey(sessionKey);
  const [info, setInfo] = useState<AgentSessionView | null | "loading" | "failed">("loading");
  const [notice, setNotice] = useState<"fallback" | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const key = handle === null ? null : `${handle.generation}.${handle.sessionId}`;
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    setInfo("loading");
    apiRef.current
      .describe(parseSessionKey(key)!)
      .then((v) => !cancelled && setInfo(v))
      .catch(() => !cancelled && setInfo("failed"));
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (handle === null || key === null) {
    return (
      <p role="alert" className="rh-error">
        This is not a session this plugin can show.
      </p>
    );
  }
  if (info === "loading") return <p className="rh-notice">Looking for the session…</p>;
  if (info === "failed") {
    return (
      <p role="alert" className="rh-error">
        Could not look up this session.
      </p>
    );
  }
  if (info === null || info.state === "closed") {
    return (
      <p role="status" className="rh-notice">
        This session is no longer open.
      </p>
    );
  }
  const thread = agentThreadOf(info);
  return (
    <div className="rh-session-card" role="group" aria-label="Live remote session" data-testid="session-card">
      <p>
        <strong>Live session</strong> — {info.kind === "rdp" ? "desktop" : info.kind === "vnc" ? "graphics" : "terminal"}
        {thread !== null ? `, with agent thread ${thread}` : ""}.{" "}
        {info.watching ? "You are watching it." : info.watchingRequired ? "The agent can act only while you watch it." : "Your setting lets the agent act without a watcher."}
      </p>
      <div className="rh-session-card-actions">
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            void api.watchInSplit(key, thread).then((o) => setNotice(o.result === "fallback" ? "fallback" : null), () => undefined);
          }}
        >
          Watch in split
        </button>
        <button type="button" onClick={() => api.open(key)}>
          Open live view
        </button>
      </div>
      {notice === "fallback" && thread !== null && (
        <p role="status" className="rh-notice">
          This window cannot split. The live view is open; the agent's thread is{" "}
          <button type="button" className="rh-link" onClick={() => api.openThread(thread)}>
            one click away
          </button>
          .
        </p>
      )}
    </div>
  );
}
