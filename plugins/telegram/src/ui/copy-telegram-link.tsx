import { Link2 } from "lucide-react";
import { useState } from "react";

export type MessageLinkLoader = (id: string, messageId: string) => Promise<string | null>;

export function CopyTelegramLink({ chatId, messageId, load }: { chatId: string; messageId: string; load: MessageLinkLoader }) {
  const [status, setStatus] = useState<"busy" | "copied" | "unavailable">();
  const [link, setLink] = useState<string>();

  async function copy() {
    setStatus("busy");
    setLink(undefined);
    try {
      const url = await load(chatId, messageId);
      if (!url) { setStatus("unavailable"); return; }
      try {
        await navigator.clipboard.writeText(url);
        setStatus("copied");
      } catch {
        setStatus(undefined);
        setLink(url);
      }
    } catch { setStatus("unavailable"); }
  }

  return <>
    <button type="button" className="mtg-reply-action" aria-label="Copy Telegram message link"
      title="Copy Telegram message link" disabled={status === "busy"} onClick={() => void copy()}><Link2 size={15} aria-hidden="true" /></button>
    {status === "copied" && <span role="status">Telegram link copied</span>}
    {status === "unavailable" && <span role="status">Telegram link unavailable</span>}
    {link && <input aria-label="Telegram message link" value={link} readOnly onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
