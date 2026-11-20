import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useState } from "react";
import type { Message } from "../core/demo.ts";

export type BanMessageChatSender = (chatId: string, messageId: string, senderChatId: string)
  => Promise<"banned" | "changed" | "unavailable">;

export const ChatSenderBan = createContext<{ chatId: string; chatName: string; ban: BanMessageChatSender } | undefined>(undefined);

export function MessageChatSenderBan({ chatId, message }: { chatId: string; message: Message }) {
  const scope = useContext(ChatSenderBan);
  const sender = message.sender;
  if (!scope || scope.chatId !== chatId || sender?.kind !== "chat" || sender.id === chatId || !message.author
    || message.outgoing || message.retained || message.pendingDelivery || message.service || !/^[1-9]\d{0,15}$/.test(message.id)) return null;
  return <ChatSenderBanControl key={`${chatId}:${message.id}:${sender.id}`} name={message.author} chatName={scope.chatName}
    ban={() => scope.ban(chatId, message.id, sender.id)} />;
}

function ChatSenderBanControl({ name, chatName, ban }: { name: string; chatName: string; ban: () => ReturnType<BanMessageChatSender> }) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"review" | "pending" | "banned" | "changed" | "unavailable">();

  async function confirm() {
    if (status !== "review") return;
    setStatus("pending");
    setStatus(await ban().catch(() => "unavailable" as const));
  }

  return <>
    {status !== "review" && status !== "pending" && status !== "banned" &&
      <button type="button" className="mtg-reply-action" onClick={() => setStatus("review")}>{tr("Ban chat sender")}</button>}
    {status === "review" || status === "pending" ? <div role="group" aria-label={tr("Confirm ban of chat sender")}>
      <p>{tr("Ban ")}<bdi>{name}</bdi>{tr(" from sending messages in ")}<bdi>{chatName}</bdi>{tr(" indefinitely?")}</p>
      <button type="button" className="mtg-action" disabled={status === "pending"} onClick={() => void confirm()}>{tr("Confirm sender ban")}</button>
      <button type="button" className="mtg-action" disabled={status === "pending"} onClick={() => setStatus(undefined)}>{tr("Cancel")}</button>
    </div> : status && <p role="status">{status === "banned" ? tr("Chat sender banned.")
      : status === "changed" ? tr("The message or sender status changed. Review the current conversation.")
        : tr("Telegram could not confirm the ban.")}</p>}
  </>;
}
