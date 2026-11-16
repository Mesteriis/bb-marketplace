import { useState, type ReactNode } from "react";
import { Hash } from "lucide-react";

export function CopyMessageReference({ chatId, messageId, forumTopicId }: {
  chatId: string;
  messageId: string;
  forumTopicId?: number;
}) {
  if (!/^[1-9]\d{0,15}$/.test(messageId)) return null;
  const reference = JSON.stringify({ chatId, ...(forumTopicId === undefined ? {} : { forumTopicId }), messageId });
  return <CopyReference label="Message reference" value={reference}>#</CopyReference>;
}

export function CopyRecipientReference({ chatId, forumTopicId }: { chatId: string; forumTopicId?: number }) {
  if (!/^-?[1-9]\d{0,15}$/.test(chatId)) return null;
  const label = forumTopicId === undefined ? "Chat reference" : "Topic reference";
  const reference = JSON.stringify({ recipientId: chatId, ...(forumTopicId === undefined ? {} : { forumTopicId }) });
  return <CopyReference label={label} value={reference} buttonClass={forumTopicId === undefined ? "mtg-reply-action" : "mtg-action"}>
    {forumTopicId === undefined ? <Hash size={15} aria-hidden="true" /> : `Copy ${label.toLowerCase()}`}
  </CopyReference>;
}

export function CopyReference({ label, value, buttonClass = "mtg-reply-action", children }: {
  label: string;
  value: string;
  buttonClass?: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<"copied" | "unavailable">();
  const copyLabel = `Copy ${label.toLowerCase()}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("unavailable");
    }
  }

  return <>
    <button type="button" className={buttonClass} aria-label={copyLabel} title={copyLabel}
      onClick={() => void copy()}>{children}</button>
    {status === "copied" && <span role="status">{label} copied</span>}
    {status === "unavailable" && <input aria-label={label} value={value} readOnly
      onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
