import { useEffect, useRef, useState } from "react";
import { Clock, Eye, Shield } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import type { MiniAppAgentMode, MiniAppAgentSnapshot, MiniAppAgentState } from "../core/mini-app-agent.ts";
import { useTelegramLocale } from "./i18n/index.tsx";

export type MiniAppAgentActions = {
  agentThreads?: readonly { id: string; title: string }[];
  agentGrant?: (session: string, threadId: string, mode: MiniAppAgentMode, snapshot: MiniAppAgentSnapshot) => Promise<boolean>;
  agentRevoke?: (session: string) => Promise<boolean>;
  agentPoll?: (session: string, snapshot: MiniAppAgentSnapshot, completed?: { id: number; sent: boolean }) => Promise<MiniAppAgentState | null>;
};

const eventLabels = {
  granted: "Granted access for this session",
  revoked: "Revoked agent access",
  viewed: "Agent inspected Mini App controls",
  back: "Agent used the Mini App Back control",
  backUnavailable: "Mini App Back control was unavailable",
} as const;

export function MiniAppAgentPanel({ actions, session, visible, active, snapshot, goBack }: {
  actions: MiniAppAgentActions;
  session: string;
  visible: boolean;
  active: boolean;
  snapshot: MiniAppAgentSnapshot;
  goBack(): boolean;
}) {
  const { t, locale } = useTelegramLocale();
  const [thread, setThread] = useState("");
  const [mode, setMode] = useState<MiniAppAgentMode>("view");
  const [state, setState] = useState<MiniAppAgentState>({ grant: null, events: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const changingAccess = useRef(false);
  const latest = useRef({ snapshot, goBack });
  latest.current = { snapshot, goBack };
  const { agentGrant, agentRevoke, agentPoll, agentThreads } = actions;
  const watching = visible || state.grant !== null;

  useEffect(() => {
    if (!agentRevoke || active) return;
    void agentRevoke(session).catch(() => {});
  }, [active, agentRevoke, session]);

  useEffect(() => {
    if (!agentRevoke) return;
    const revoke = () => { if (document.hidden) void agentRevoke(session).catch(() => {}); };
    document.addEventListener("visibilitychange", revoke);
    return () => {
      document.removeEventListener("visibilitychange", revoke);
      void agentRevoke(session).catch(() => {});
    };
  }, [agentRevoke, session]);

  useEffect(() => {
    if (!agentPoll || !active || !watching) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let completed: { id: number; sent: boolean } | undefined;
    async function poll() {
      if (!document.hidden) {
        try {
          const next = await agentPoll!(session, latest.current.snapshot, completed);
          if (stopped) return;
          completed = undefined;
          if (next) {
            setState(next);
            if (next.command !== undefined) {
              completed = { id: next.command, sent: !changingAccess.current && !document.hidden && latest.current.goBack() };
            }
          } else {
            setState((previous) => ({ ...previous, grant: null }));
          }
        } catch {
          if (!stopped) setError(true);
        }
      }
      if (!stopped) timer = setTimeout(poll, 800);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, agentPoll, session, watching]);

  async function changeAccess() {
    if (changingAccess.current || !agentGrant || !agentRevoke) return;
    changingAccess.current = true;
    const revoking = state.grant !== null;
    setBusy(true);
    setError(false);
    try {
      const changed = revoking ? await agentRevoke(session)
        : active && await agentGrant(session, thread, mode, latest.current.snapshot);
      if (!changed) setError(true);
      else setState((previous) => ({ ...previous, grant: revoking ? null : { threadId: thread, mode } }));
    } catch {
      setError(true);
    } finally {
      changingAccess.current = false;
      setBusy(false);
    }
  }

  const activeThread = agentThreads?.find(({ id }) => id === state.grant?.threadId);
  return <aside className="mtg-mini-app-agent" aria-label={t("Mini App agent access")} hidden={!visible}>
    <div className="mtg-mini-app-agent-heading">
      <Shield size={19} aria-hidden="true" />
      <div><h2>{t("Mini App agent access")}</h2>
        <p role="status">{state.grant ? t("Allowed for this session") : t("Access is off")}</p></div>
    </div>
    <div className="mtg-mini-app-agent-controls">
      {state.grant ? <>
        {activeThread && <p>{activeThread.title}</p>}
        <p className="mtg-mini-app-agent-mode"><Eye size={16} aria-hidden="true" />{t(state.grant.mode === "view" ? "View controls" : "View controls and go back")}</p>
      </> : <>
        <label>{t("BB thread")}
          <select value={thread} onChange={(event) => setThread(event.currentTarget.value)}>
            <option value="">{t("Choose a BB thread")}</option>
            {agentThreads?.map(({ id, title }) => <option key={id} value={id}>{title || id}</option>)}
          </select>
        </label>
        <label>{t("Access mode")}
          <select value={mode} onChange={(event) => setMode(event.currentTarget.value as MiniAppAgentMode)}>
            <option value="view">{t("View controls")}</option>
            <option value="navigate">{t("View controls and go back")}</option>
          </select>
        </label>
      </>}
      <Button type="button" data-granted={!!state.grant} variant={state.grant ? "outline" : "default"} disabled={busy || (!state.grant && (!thread || !active))}
        onClick={() => void changeAccess()}>{t(state.grant ? "Revoke access" : "Grant access")}</Button>
      {error && <p role="alert">{t("Could not update Mini App agent access.")}</p>}
    </div>
    <section className="mtg-mini-app-agent-journal" aria-label={t("Activity log")}>
      <h3><Clock size={17} aria-hidden="true" />{t("Activity log")}</h3>
      {state.events.length ? <ol aria-live="polite">{state.events.map(({ id, at, action }) => <li key={id}>
        <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString(locale)}</time>
        <span>{t(eventLabels[action])}</span>
      </li>)}</ol> : <p>{t("No agent activity yet.")}</p>}
    </section>
  </aside>;
}
