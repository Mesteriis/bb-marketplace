// The owner's standing notice that an agent is active (stage 4c: agents are never hidden). Mounted app-wide, so it shows
// wherever the owner is in BB. It learns of changes from the plugin's realtime signal (identifiers only, nothing is read
// from it) and asks the owner-only RPC for the details, with a slow poll as a backstop for a signal that was missed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHandle } from "../core/rpc.ts";
import type { AgentSessionView } from "./agent-panel.tsx";
import { agentThreadOf, type SplitOutcome } from "./split-watch.ts";

export interface AgentBannerApi {
  sessions: () => Promise<AgentSessionView[]>;
  takeover: (handle: SessionHandle) => Promise<unknown>;
  /** Shows the session's live view (the side tab where BB can open it, else the plugin page). */
  watch: (sessionKey: string) => void;
  /** The live view in the main pane and the agent's thread in a split beside it. */
  watchInSplit: (sessionKey: string, agentThread: string | null) => Promise<SplitOutcome>;
  /** The agent's thread on its own (the way back when splits are off). */
  openThread: (threadId: string) => void;
  /** Calls `cb` when the server says an agent did something; returns the unsubscribe. */
  subscribe: (cb: () => void) => () => void;
}

const POLL_MS = 5000;

/** An agent that holds a session, or opened one that is still open. */
export function bannerRows(all: AgentSessionView[]): AgentSessionView[] {
  return all.filter((s) => s.state !== "closed" && (s.controlledBy === "agent" || s.openedByThread !== null));
}

export function AgentBanner({ api }: { api: AgentBannerApi }) {
  const [rows, setRows] = useState<AgentSessionView[]>([]);
  // Sessions whose split could not be made: the way to the thread is a link instead.
  const [noSplit, setNoSplit] = useState<ReadonlySet<string>>(new Set());
  const apiRef = useRef(api);
  apiRef.current = api;
  const refresh = useCallback(() => {
    apiRef.current
      .sessions()
      .then((all) => setRows(bannerRows(all)))
      .catch(() => undefined); // the banner stays as it was; the page shows the details
  }, []);
  useEffect(() => {
    refresh();
    const off = api.subscribe(refresh);
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [api, refresh]);
  if (rows.length === 0) return null;
  return (
    <div className="rh-agent-banner" role="region" aria-label="Агенты в удалённых сессиях">
      {rows.map((s) => {
        const key = `${s.generation}.${s.sessionId}`;
        const driving = s.controlledBy === "agent";
        return (
          <div key={key} role="status" className="rh-agent-banner-row" data-testid="agent-banner-row">
            <span>
              {driving ? "Агент управляет сессией" : "Агент открыл сессию"} ({s.kind === "rdp" ? "рабочий стол" : "терминал"}).{" "}
              {s.watching ? "Вы смотрите." : !s.watchingRequired ? "Никто не смотрит, но ваша настройка разрешает ему действовать." : driving ? "Он на паузе: никто не смотрит." : "Он не может действовать, пока вы не смотрите."}
            </span>
            <button
              type="button"
              onClick={() => {
                const thread = agentThreadOf(s);
                void api.watchInSplit(key, thread).then(
                  (o) => setNoSplit((cur) => new Set(o.result === "fallback" ? [...cur, key] : [...cur].filter((k) => k !== key))),
                  () => undefined,
                );
              }}
            >
              Рядом с тредом
            </button>
            <button type="button" onClick={() => api.watch(key)}>
              Смотреть
            </button>
            {noSplit.has(key) && agentThreadOf(s) !== null && (
              <button type="button" className="rh-link" onClick={() => api.openThread(agentThreadOf(s)!)}>
                Разделение здесь выключено: открыть тред агента
              </button>
            )}
            {driving && (
              <button type="button" onClick={() => void api.takeover({ generation: s.generation, sessionId: s.sessionId }).then(refresh, refresh)}>
                Взять управление
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
