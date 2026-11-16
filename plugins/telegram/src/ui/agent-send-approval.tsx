import { useState } from "react";
import { ApprovalCountdown } from "./approval-countdown.tsx";
import { approvalSchema } from "../core/agent-approval.ts";

export function AgentSendApproval({ payload, expiresAt, submit, cancel }: {
  payload: unknown;
  expiresAt?: number | null;
  submit: (value: { id: string }) => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const parsed = approvalSchema.safeParse(payload);
  const [id, setId] = useState(() => parsed.success && parsed.data.recipients.length === 1 ? parsed.data.recipients[0]!.id : "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const recipient = parsed.success ? parsed.data.recipients.find((item) => item.id === id) : undefined;

  const recipients = parsed.success ? parsed.data.recipients : [];
  const normalizedLabel = (name: string, kind: string) => `${name.normalize("NFKC").trim().toLowerCase()} · ${kind}`;
  const labels = recipients.map(({ name, kind }) => normalizedLabel(name, kind));

  async function settle(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try { await action(); }
    catch { setFailed(true); setBusy(false); }
  }

  return <section className="mtg-agent-approval" aria-label="Telegram send approval">
    <strong>Approve Telegram message</strong>
    {parsed.success ? <>
      {parsed.data.replyPreview && <div>
        <strong>Replying to</strong>
        <blockquote className="mtg-agent-text">{parsed.data.replyPreview}</blockquote>
      </div>}
      {parsed.data.forumTopic && <p>Forum topic <bdi>{parsed.data.forumTopic.name} · ID {parsed.data.forumTopic.id}</bdi></p>}
      <p className="mtg-agent-text">{parsed.data.text}</p>
      <label>Send to <select value={id} onChange={(event) => setId(event.target.value)} disabled={busy}>
        <option value="">Choose a Telegram chat</option>
        {recipients.map(({ id, name, kind, archived }, index) => {
          const duplicate = labels.some((label, other) => other !== index && label === labels[index]);
          const showId = duplicate || parsed.data.showRecipientId || kind === "Group" || kind === "Channel";
          return <option value={id} key={id}>
            {name} · {kind}{archived ? " · Archived" : ""}{showId ? ` · Chat ID ${id}` : ""}
          </option>;
        })}
      </select></label>
      {recipient?.sender && <p>Sending as <bdi>{recipient.sender}</bdi></p>}
    </> : <p role="alert">This approval request is invalid.</p>}
    {expiresAt != null && <ApprovalCountdown expiresAt={expiresAt} />}
    {failed && <p role="alert">BB could not submit the decision. Try again.</p>}
    <div>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void settle(cancel)}>Cancel</button>
      <button type="button" className="mtg-action" disabled={busy || !recipient} onClick={() => {
        if (recipient) void settle(() => submit({ id: recipient.id }));
      }}>Confirm send</button>
    </div>
  </section>;
}
