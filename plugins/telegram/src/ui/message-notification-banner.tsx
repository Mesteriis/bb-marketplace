import { useRef, useState } from "react";
import type { MessageNotification } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export function MessageNotificationBanner({ notification, chat, load, open, dismiss }: {
  notification: MessageNotification;
  chat?: Chat;
  load?: (id: string) => Promise<Chat | null>;
  open: (chat: Chat) => void;
  dismiss?: () => void;
}) {
  const banner = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function openMessage() {
    if (chat) { open(chat); return; }
    if (!load || busy) return;
    setBusy(true);
    setError(false);
    const target = await load(notification.chatId).catch(() => null);
    if (!banner.current) return;
    if (target?.id === notification.chatId) open(target);
    else {
      setError(true);
      setBusy(false);
    }
  }

  return <aside ref={banner} className="mtg-message-notification" aria-label="Telegram notification">
    <div role="status"><strong>{chat?.name ?? "Telegram"}</strong>
      <div>{notification.preview ?? "New message"}</div></div>
    {error && <div role="alert">Could not open this message.</div>}
    {(chat || load) && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void openMessage()}>{busy ? "Opening…" : "Open message"}</button>}
    <button type="button" className="mtg-action" onClick={dismiss}>Dismiss</button>
  </aside>;
}
