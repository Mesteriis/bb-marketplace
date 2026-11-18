// The owner's view of agent access (stage 4a): which connections agents may use and at what level, and what they
// did. Shows metadata only; the audit never holds terminal text, keystrokes, screenshots or secrets.
import { useCallback, useEffect, useState } from "react";
import type { AgentLevel } from "../core/agent-access.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import type { RdpCertPromptInfo, RdpDecision, SessionHandle } from "../core/rpc.ts";
import { RdpCertDialog } from "./rdp-cert-dialog.tsx";
import { SshPromptDialog } from "./ssh-prompt.tsx";

export interface AgentGrantView {
  profileId: string;
  level: Exclude<AgentLevel, "none">;
  recordCommands: boolean;
  updatedAt: string;
}
export interface AgentAuditView {
  id: number;
  at: string;
  threadId: string;
  projectId: string;
  tool: string;
  profileId: string | null;
  sessionKey: string | null;
  detailMode: "none" | "length" | "text";
  detail: string | null;
  outcome: string | null;
  count: number;
}

/** A session an agent opened or holds, and what waits for the owner on it (stage 4b-1). */
export interface AgentSessionView {
  generation: string;
  sessionId: number;
  kind: "echo" | "ssh" | "rdp";
  connectionId: string | null;
  state: "connecting" | "running" | "closed";
  openedByThread: string | null;
  openedByArchivedThread: boolean;
  holdUntil: number | null;
  controlledBy: "human" | "agent";
  leaseThreadId: string | null;
  leaseExpiresAt: number | null;
  questions: Array<{ kind: "host_key" | "login_prompt"; promptId: number; text: string }>;
  certificate: RdpCertPromptInfo | null;
}

export interface AgentApi {
  list: () => Promise<AgentGrantView[]>;
  set: (profileId: string, level: AgentLevel, recordCommands: boolean) => Promise<{ profileId: string; level: AgentLevel; recordCommands: boolean }>;
  revokeAll: () => Promise<{ revoked: number }>;
  audit: (limit: number) => Promise<AgentAuditView[]>;
  sessions: () => Promise<AgentSessionView[]>;
  /** The owner takes a session back from an agent at once. */
  takeover: (handle: SessionHandle) => Promise<{ tookOver: boolean }>;
  /** The owner lets agents drive again before the hold after a takeover has run out. */
  allowAgents: (handle: SessionHandle) => Promise<{ allowed: boolean }>;
  /** The owner's answer to a host-key or login question (null = refuse). */
  answer: (handle: SessionHandle, promptId: number, answer: string | null) => Promise<{ answered: true }>;
  decideCertificate: (handle: SessionHandle, fingerprint: string, accept: RdpDecision) => Promise<void>;
  disconnect: (handle: SessionHandle) => Promise<void>;
}

export const LEVEL_TEXT: Record<AgentLevel, string> = {
  none: "No access",
  observe: "Observe: read output and screenshots",
  input: "Input: observe, connect and type (not yet available)",
  exec: "Exec: input, and run commands (not yet available)",
};

/** What the owner is told wherever a grant is set. */
export const ACCESS_NOTE =
  "Applies to agents in ANY thread of this BB. Levels are ordered: no access < observe < input < exec, and connecting is allowed from input up. " +
  "Agents never get a saved password or key, and a new host key or a changed certificate is always your decision. " +
  "But with Observe an agent can read everything the terminal prints (including what is already in its scrollback) and everything visible on the remote screen, including a secret shown there. " +
  "These levels restrict the tools registered for agents; they are not a sandbox: an agent that can run shell commands as you can still reach this plugin.";

export interface AgentPanelProps {
  api: AgentApi;
  /** Names for the profile ids in the lists. */
  profileNames: Map<string, string>;
  onClose: () => void;
}

const outcomeText = (outcome: string | null): string => (outcome === null ? "unfinished (no outcome was recorded)" : outcome);
const detailText = (r: AgentAuditView): string =>
  r.detailMode === "text" ? "command: " + (r.detail ?? "") : r.detailMode === "length" ? "recorded as its length only" : "";

export function AgentPanel({ api, profileNames, onClose }: AgentPanelProps) {
  const [grants, setGrants] = useState<AgentGrantView[] | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionView[] | null>(null);
  const [rows, setRows] = useState<AgentAuditView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants(await api.list());
      setRows(await api.audit(500));
      setAgentSessions(await api.sessions());
      setProblem(null);
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [api]);
  useEffect(() => {
    void load();
    // Questions and leases change on their own; keep the list current while the screen is open.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const fail = (e: unknown) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
  const act = (run: () => Promise<unknown>) => void run().then(load).catch(fail);

  // Questions are dialogs over the page: only the first session that asks gets one, so two never overlap.
  const asking = (agentSessions ?? []).find((s) => s.questions.length > 0 || s.certificate !== null);
  const isChange = (r: AgentAuditView) => r.tool.startsWith("access.");
  const changes = (rows ?? []).filter(isChange).slice(0, 20);
  const activity = (rows ?? []).filter((r) => !isChange(r));
  const name = (id: string | null) => (id === null ? "" : (profileNames.get(id) ?? "a deleted connection"));

  return (
    <section aria-label="Agent activity" className="rh-import rh-agents">
      <div className="rh-import-head">
        <h2>Agent access and activity</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="rh-hint">{ACCESS_NOTE}</p>
      {problem !== null && <p className="rh-error" role="alert">{problem}</p>}
      {message !== null && <p role="status" className="rh-hint">{message}</p>}

      <h3>Access changes</h3>
      <p className="rh-hint">Every change of a grant and every "revoke all" is recorded here, newest first.</p>
      {rows !== null && changes.length === 0 && <p className="rh-hint">No grant has been changed yet.</p>}
      <ul aria-label="Access changes">
        {changes.map((r) => (
          <li key={r.id} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{r.tool === "access.revoke_all" ? "Revoke all" : "Set access"}</strong> <span className="rh-badge">{outcomeText(r.outcome)}</span>
              <span className="rh-profile-endpoint">
                {r.at} · by {r.threadId}
                {r.profileId !== null ? " · " + name(r.profileId) : ""}
                {r.detail !== null ? " · " + r.detail : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <h3>Sessions agents opened or drive</h3>
      <p className="rh-hint">A new host key, a changed key, a certificate or a login question on a session an agent opened is yours to answer here. An agent only learns that it is waiting for you.</p>
      {agentSessions !== null && agentSessions.length === 0 && <p className="rh-hint">No agent has opened or is driving a session.</p>}
      <ul aria-label="Agent sessions">
        {(agentSessions ?? []).map((s) => {
          const handle = { generation: s.generation, sessionId: s.sessionId };
          const label = s.connectionId === null ? "a session" : name(s.connectionId);
          return (
            <li key={`${s.generation}.${s.sessionId}`} className="rh-profile">
              <div className="rh-profile-main">
                <strong>{label}</strong> <span className="rh-badge">{s.state}</span>
                <span className="rh-profile-endpoint">
                  {s.kind}
                  {s.openedByThread !== null ? (s.openedByArchivedThread ? ` · opened by an archived thread (${s.openedByThread})` : ` · opened by agent thread ${s.openedByThread}`) : ""}
                  {" · "}
                  {s.holdUntil !== null ? `kept by you until ${new Date(s.holdUntil).toLocaleTimeString()} · ` : ""}{s.controlledBy === "agent" ? `driven by an agent (thread ${s.leaseThreadId ?? "?"}${s.leaseExpiresAt !== null ? ", until " + new Date(s.leaseExpiresAt).toLocaleTimeString() : ""})` : "driven by you"}
                </span>
              </div>
              <div className="rh-profile-actions">
                {s.controlledBy === "agent" && (
                  <button type="button" aria-label={"Take control of " + label} onClick={() => act(() => api.takeover(handle))}>
                    Take control
                  </button>
                )}
                {s.holdUntil !== null && (
                  <button type="button" aria-label={"Let agents drive " + label + " again"} onClick={() => act(() => api.allowAgents(handle))}>
                    Let agents drive again
                  </button>
                )}
                {s.state !== "closed" && (
                  <button type="button" aria-label={"Disconnect " + label} onClick={() => act(() => api.disconnect(handle))}>
                    Disconnect
                  </button>
                )}
              </div>
              {(s.questions.length > 0 || s.certificate !== null) && s !== asking && <p className="rh-hint">A question is waiting for you on this session; it opens after the other one is answered.</p>}
              {s === asking && s.questions[0] !== undefined && (
                <SshPromptDialog prompt={{ promptId: s.questions[0].promptId, text: s.questions[0].text, kind: s.questions[0].kind === "host_key" ? "confirm" : "secret" }} onAnswer={(promptId, answer) => act(() => api.answer(handle, promptId, answer))} />
              )}
              {s === asking && s.questions[0] === undefined && s.certificate !== null && <RdpCertDialog prompt={s.certificate} onDecide={(fingerprint, accept) => act(() => api.decideCertificate(handle, fingerprint, accept))} />}
            </li>
          );
        })}
      </ul>

      <h3>Connections agents may use</h3>
      {grants !== null && grants.length === 0 && <p className="rh-hint">None. Agents cannot see or use any connection. Set access in a connection's editor.</p>}
      <ul aria-label="Granted connections">
        {(grants ?? []).map((g) => (
          <li key={g.profileId} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{name(g.profileId)}</strong> <span className="rh-badge">{g.level}</span>
              {g.recordCommands && <span className="rh-hint">commands are recorded in the activity list</span>}
            </div>
            <div className="rh-profile-actions">
              <button
                type="button"
                disabled={busy}
                aria-label={"Revoke access to " + name(g.profileId)}
                onClick={() => {
                  setBusy(true);
                  void api
                    .set(g.profileId, "none", false)
                    .then(load)
                    .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
                    .finally(() => setBusy(false));
                }}
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="rh-editor-actions">
        <button
          type="button"
          disabled={busy || grants === null || grants.length === 0}
          onClick={() => {
            setBusy(true);
            void api
              .revokeAll()
              .then(async (r) => {
                setMessage(`Agent access was switched off for ${r.revoked} connection(s).`);
                await load();
              })
              .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
              .finally(() => setBusy(false));
          }}
        >
          Revoke all agent access
        </button>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <h3>Recent agent activity</h3>
      <p className="rh-hint">Newest first, the last 5000 calls are kept. A call is recorded before it runs; "unfinished" means it never reported an outcome.</p>
      {rows !== null && activity.length === 0 && <p className="rh-hint">No agent has called a Remote Hub tool yet.</p>}
      <ul aria-label="Agent activity list">
        {activity.map((r) => (
          <li key={r.id} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{r.tool}</strong> <span className="rh-badge">{outcomeText(r.outcome)}</span>
              {r.count > 1 && <span className="rh-badge">{r.count} times</span>}
              <span className="rh-profile-endpoint">
                {r.at} · thread {r.threadId} · project {r.projectId}
                {r.profileId !== null ? " · " + name(r.profileId) : ""}
                {r.sessionKey !== null ? " · session " + r.sessionKey : ""}
              </span>
              {detailText(r) !== "" && <span className="rh-hint">{detailText(r)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
