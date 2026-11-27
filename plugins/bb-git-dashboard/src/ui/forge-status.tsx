import { useState } from "react";
import type { z } from "zod";
import type { forgeStatus } from "../core/forge/contract.ts";
import { limitation } from "../core/forge/capabilities.ts";

export type ForgeStatus = z.infer<typeof forgeStatus>;
const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"};
const reasons = {
  owner: "owns the repository", organization: "member of the organization", visible: "can see the repository",
  host: "only account on this server", linked: "connected", ambiguous: "", none: "",
};

/** Which forge and account a working copy uses, and the choice when it cannot be made automatically. */
export function ForgeStatusLine({status, busy, onRecheck, onChoose}: {
  status: ForgeStatus; busy: boolean; onRecheck(): void; onChoose(accountId: string): void;
}) {
  const [choice, setChoice] = useState(status.candidates[0]?.id ?? "");
  const {detection, remote} = status;
  if (!remote || !detection) return <p className="git-muted" role="status">No forge remote: this copy has no usable origin.</p>;
  const where = detection.host + (remote.path ? "/" + remote.path : "");
  if (!detection.kind || detection.status === "unreachable") {
    return <div className="git-row" role="status">
      <span className="git-muted">{detection.status === "unreachable" ? "Server did not answer" : "Unknown Git server"} · {detection.kind ? forgeNames[detection.kind] + " by name · " : ""}{where}</span>
      <button type="button" disabled={busy} onClick={onRecheck}>Recheck</button>
    </div>;
  }
  const account = status.candidates.find(row => row.id === status.chosen);
  const unsupported = limitation(detection.kind, "repositories");
  return <div className="git-stack" role="status">
    <p className="git-muted">{forgeNames[detection.kind]} · {where}
      {account && <> · {account.label} ({account.username}){reasons[status.reason] ? " — " + reasons[status.reason] : ""}</>}
      {status.reason === "linked" && !account && " · connected"}</p>
    {unsupported && <p className="git-muted">{unsupported}</p>}
    {status.reason === "ambiguous" && <div className="git-row">
      <select aria-label="Account for this repository" value={choice} onChange={event => setChoice(event.target.value)}>
        {status.candidates.map(row => <option key={row.id} value={row.id}>{row.label} ({row.username})</option>)}
      </select>
      <button type="button" disabled={busy || !choice} onClick={() => onChoose(choice)}>Use this account</button>
    </div>}
    {status.reason === "none" && !unsupported && <p className="git-muted">No connected account for {detection.origin}.</p>}
    {status.error && <p className="git-error" role="alert">Automatic connection failed: {status.error}</p>}
  </div>;
}
