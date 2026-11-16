import { Pin } from "lucide-react";
import { useState } from "react";

export type MessagePinActions = {
  pinStatus: (id: string, messageId: string) => Promise<boolean | null>;
  setMessagePinned: (id: string, messageId: string, pinned: boolean) => Promise<"updated" | "refused" | "unknown">;
};

export function MessagePin({ chatId, messageId, pinStatus, setMessagePinned, inTopic = false }: MessagePinActions & {
  chatId: string;
  messageId: string;
  inTopic?: boolean;
}) {
  const [prompt, setPrompt] = useState<{ pinned?: boolean; busy?: boolean; status?: string }>();

  async function open() {
    setPrompt({ busy: true, status: "Checking pin options…" });
    try {
      const pinned = await pinStatus(chatId, messageId);
      setPrompt(pinned === null ? { status: "You can’t manage this pin in Telegram." } : { pinned });
    } catch {
      setPrompt({ status: "Could not check this pin in Telegram." });
    }
  }

  async function change(pinned: boolean) {
    setPrompt({ busy: true, status: "Updating pinned message…" });
    const result = await setMessagePinned(chatId, messageId, pinned).catch(() => "unknown");
    setPrompt({ status: result === "updated" ? pinned ? "Message pinned." : "Message unpinned."
      : result === "refused" ? "Telegram refused to update the pin."
      : "Telegram did not confirm the update." });
  }

  if (!prompt) return <button type="button" className="mtg-reply-action" aria-label="Manage message pin"
    title="Manage message pin" onClick={() => void open()}><Pin size={15} aria-hidden="true" /></button>;

  return <div className="mtg-edit" role="group" aria-label="Message pin">
    {prompt.status && <p role="status">{prompt.status}</p>}
    <div>
      {prompt.pinned !== undefined && <button type="button" className="mtg-action"
        onClick={() => void change(!prompt.pinned)}>{prompt.pinned ? (inTopic ? "Unpin from topic" : "Unpin from chat") : (inTopic ? "Pin in topic" : "Pin in chat")}</button>}
      {!prompt.busy && <button type="button" className="mtg-action"
        onClick={() => setPrompt(undefined)}>{prompt.pinned === undefined ? "Close" : "Cancel"}</button>}
    </div>
  </div>;
}
