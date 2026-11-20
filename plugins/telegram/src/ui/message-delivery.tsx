import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Message } from "../core/demo.ts";

type Retry = (chatId: string, messageId: string) => Promise<"sent" | "failed" | "unavailable" | "unknown">;
export const RetryMessageDelivery = createContext<Retry | undefined>(undefined);

export function MessageDelivery({ chatId, message }: { chatId: string; message: Message }) {
  const { t: tr } = useTelegramLocale();
  const retry = useContext(RetryMessageDelivery);
  const retryAt = message.failedDelivery?.retryAt;
  const [clock, setClock] = useState(() => Date.now());
  const [status, setStatus] = useState<Awaited<ReturnType<Retry>> | "busy">();
  const inFlight = useRef(false);
  useEffect(() => {
    if (!retryAt) return;
    const delay = retryAt - Date.now();
    if (delay <= 0) {
      setClock(Date.now());
      return;
    }
    const timer = setTimeout(() => setClock(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [retryAt]);

  async function sendAgain() {
    if (!retry || inFlight.current || retryAt === undefined || retryAt > Date.now()) return;
    inFlight.current = true;
    setStatus("busy");
    try {
      setStatus(await retry(chatId, message.id));
    } catch {
      setStatus("unknown");
    } finally {
      inFlight.current = false;
    }
  }

  if (!message.failedDelivery) return <span className="mtg-send-status">{tr("Sending…")}</span>;
  return <div className="mtg-send-status">
    <span role="status">{status === "busy" ? tr("Retrying…") : status === "sent" ? tr("Sent.")
      : status === "unknown" ? tr("Telegram did not confirm the retry.") : status === "unavailable" ? tr("Telegram cannot retry this message yet.")
        : retryAt !== undefined && retryAt > clock ? tr("Message not sent. Waiting to retry.") : tr("Message not sent.")}</span>
    {retry && retryAt !== undefined && retryAt <= clock && status !== "sent" && status !== "busy" && status !== "unknown" &&
      <button type="button" className="mtg-action" onClick={() => void sendAgain()}>{tr("Retry send")}</button>}
  </div>;
}
