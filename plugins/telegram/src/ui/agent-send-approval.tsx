import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import { ApprovalTime, useApprovalSeconds } from "./approval-countdown.tsx";
import { approvalSchema } from "../core/agent-approval.ts";

export function AgentSendApproval({ payload, expiresAt, submit, cancel }: {
  payload: unknown;
  expiresAt?: number | null;
  submit: (value: { id: string }) => Promise<void>;
  cancel: () => Promise<void>;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const parsed = approvalSchema.safeParse(payload);
  const [id, setId] = useState(() => parsed.success && parsed.data.recipients.length === 1 ? parsed.data.recipients[0]!.id : "");
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const seconds = useApprovalSeconds(expiresAt);
  const expired = seconds === 0;
  const [failed, setFailed] = useState(false);
  const recipient = parsed.success ? parsed.data.recipients.find((item) => item.id === id) : undefined;

  const recipients = parsed.success ? parsed.data.recipients : [];
  const normalizedLabel = (name: string, kind: string) => `${name.normalize("NFKC").trim().toLowerCase()} · ${kind}`;
  const labels = recipients.map(({ name, kind }) => normalizedLabel(name, kind));

  async function settle(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try { await action(); }
    catch { inFlight.current = false; setFailed(true); setBusy(false); }
  }

  return <section lang={uiLocale} data-bb-ru-skip className="mtg-agent-approval" aria-label={tr("Telegram send approval")}>
    <strong>{tr("Approve Telegram message")}</strong>
    {parsed.success ? <>
      {parsed.data.accountLabel && <p>{tr("Telegram account ")}<bdi>{parsed.data.accountLabel}</bdi></p>}
      {parsed.data.replyPreview && <div>
        <strong>{parsed.data.replyKind === "voice" ? tr("Replying to a voice note") :
          parsed.data.replyKind === "video" ? tr("Replying to a video note") : tr("Replying to")}</strong>
        <blockquote className="mtg-agent-text">{parsed.data.replyPreview}</blockquote>
      </div>}
      {parsed.data.forumTopic && <p>{tr("Telegram topic ")}<bdi>{parsed.data.forumTopic.name}{tr(" · ID ")}{parsed.data.forumTopic.id}</bdi></p>}
      <p className="mtg-agent-text">{parsed.data.text}</p>
      <label>{tr("Send to ")}<select value={id} onChange={(event) => setId(event.target.value)} disabled={busy || expired}>
        <option value="">{tr("Choose a Telegram chat")}</option>
        {recipients.map(({ id, name, kind, archived }, index) => {
          const duplicate = labels.some((label, other) => other !== index && label === labels[index]);
          const showId = duplicate || parsed.data.showRecipientId || kind === "Group" || kind === "Channel";
          return <option value={id} key={id}>
            {name} · {tr(kind)}{archived ? tr(" · Archived") : ""}{showId ? tr(" · Chat ID {0}", [id]) : ""}
          </option>;
        })}
      </select></label>
      {recipient?.sender && <p>{tr("Sending as ")}<bdi>{recipient.sender}</bdi></p>}
    </> : <p role="alert">{tr("This approval request is invalid.")}</p>}
    <ApprovalTime seconds={seconds} />
    {failed && <p role="alert">{tr("BB could not submit the decision. Try again.")}</p>}
    <div>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void settle(cancel)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" data-variant="primary" disabled={busy || expired || !recipient} onClick={() => {
        if (recipient && (expiresAt == null || Date.now() < expiresAt)) void settle(() => submit({ id: recipient.id }));
      }}>{tr("Confirm send")}</button>
    </div>
  </section>;
}
