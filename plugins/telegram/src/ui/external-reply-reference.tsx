import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Message } from "../core/demo.ts";

type MessageLocation = { chatId: string; messageId: string; topicId?: number; quote?: Message["replyQuoteAnchor"] };
export const OpenExternalReply = createContext<((source: MessageLocation, from: MessageLocation, signal: AbortSignal, playbackTime?: number) => Promise<boolean>) | undefined>(undefined);

export function ExternalReplyReference({ chatId, message }: { chatId: string; message: Message }) {
  const { t: tr } = useTelegramLocale();
  const open = useContext(OpenExternalReply);
  const request = useRef<AbortController | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "unavailable">();
  const source = message.replyFromChat;
  useEffect(() => () => request.current?.abort(), []);
  if (!source) return null;
  const label = message.replyQuote ?? tr("Reply to a message in another chat");

  async function navigate() {
    if (!open || !source || status === "loading") return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("loading");
    const target = message.replyQuoteAnchor ? { ...source, quote: message.replyQuoteAnchor } : source;
    const opened = await open(target, { chatId, messageId: message.id, topicId: message.forumTopicId }, controller.signal).catch(() => false);
    if (!controller.signal.aborted) setStatus(opened ? undefined : "unavailable");
  }

  return <blockquote className="mtg-reply-quote">
    {open && !message.retained && !message.pendingDelivery
      ? <button type="button" className="mtg-open-reply" aria-label={tr("Open original message in another chat")}
        disabled={status === "loading"} onClick={() => void navigate()}>{label}</button> : label}
    {status === "unavailable" && <span role="status">{tr(" Original message unavailable.")}</span>}
  </blockquote>;
}
