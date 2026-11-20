import { useTelegramLocale } from "./i18n/index.tsx";
import { CheckCheck } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ChatList, MarkReadResult } from "../core/contract.ts";

export type MarkChatListReadAction = (list: Exclude<ChatList, "saved">) => Promise<MarkReadResult>;

export function MarkChatListRead({ list, title, mark }: {
  list: Exclude<ChatList, "saved">;
  title: string;
  mark: MarkChatListReadAction;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"confirm" | "pending" | "failed" | MarkReadResult>();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const actionButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (status === "confirm") confirmButton.current?.focus({ preventScroll: true });
  }, [status]);
  async function confirm() {
    setStatus("pending");
    try {
      setStatus(await mark(list));
    } catch {
      setStatus("failed");
    }
  }
  if (status === "confirm") return <div role="group" aria-label={tr("Confirm mark all chats as read")}>
    <p>{tr("Mark every unread chat in ")}{title}{tr(" as read?")}</p>
    <button ref={confirmButton} type="button" className="mtg-action" onClick={() => void confirm()}>{tr("Mark chats as read")}</button>
    <button type="button" className="mtg-action" onClick={() => {
      setStatus(undefined);
      requestAnimationFrame(() => actionButton.current?.focus({ preventScroll: true }));
    }}>{tr("Cancel")}</button>
  </div>;
  return <div>
    <button ref={actionButton} type="button" className="mtg-action" disabled={status === "pending"}
      onClick={() => setStatus("confirm")}><CheckCheck size={16} aria-hidden="true" />{tr("Mark all chats as read")}</button>
    {status === "pending" && <p role="status">{tr("Marking chats as read…")}</p>}
    {status === "failed" && <p role="alert">{tr("Telegram could not complete the update.")}</p>}
    {typeof status === "object" && <p role="status">
      {status.read}{tr(" marked as read.")}{status.failed > 0 && tr(" {0} could not be updated.", [status.failed])}
    </p>}
  </div>;
}
