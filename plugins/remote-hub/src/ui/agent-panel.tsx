// The owner's view of agent access (stage 4a): which connections agents may use and at what level, and what they
// did. Shows metadata only; the audit never holds terminal text, keystrokes, screenshots or secrets.
import { useCallback, useEffect, useState } from "react";
import type { AgentLevel } from "../core/agent-access.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";

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
  detailMode: "none" | "hash" | "text";
  detail: string | null;
  outcome: string | null;
  count: number;
}

export interface AgentApi {
  list: () => Promise<AgentGrantView[]>;
  set: (profileId: string, level: AgentLevel, recordCommands: boolean) => Promise<{ profileId: string; level: AgentLevel; recordCommands: boolean }>;
  revokeAll: () => Promise<{ revoked: number }>;
  audit: (limit: number) => Promise<AgentAuditView[]>;
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
  r.detailMode === "text" ? "command: " + (r.detail ?? "") : r.detailMode === "hash" ? "recorded as length and hash only" : "";

export function AgentPanel({ api, profileNames, onClose }: AgentPanelProps) {
  const [grants, setGrants] = useState<AgentGrantView[] | null>(null);
  const [rows, setRows] = useState<AgentAuditView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants(await api.list());
      setRows(await api.audit(500));
      setProblem(null);
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

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
