import { Pin, PinOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatList } from "../core/contract.ts";

export type ChatPinActions = {
  chatPinStatus: (id: string, list: ChatList) => Promise<boolean | null>;
  setChatPinned: (id: string, list: ChatList, pinned: boolean) => Promise<"updated" | "refused" | "unknown">;
};

export function ChatPin({ id, list, revision, chatPinStatus, setChatPinned }: ChatPinActions & {
  id: string;
  list: ChatList;
  revision: number;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (busy) return;
    let current = true;
    void chatPinStatus(id, list).then(
      (value) => { if (current) setPinned(value); },
      () => { if (current) setPinned(null); },
    );
    return () => { current = false; };
  }, [id, list, revision, chatPinStatus, busy]);

  async function toggle() {
    if (pinned === null || busy) return;
    const next = !pinned;
    setBusy(true);
    setError("");
    const result = await setChatPinned(id, list, next).catch(() => "unknown");
    if (result === "updated") setPinned(next);
    else setError(result === "refused" ? "Telegram refused to change this pin." : "Telegram did not confirm the pin.");
    setBusy(false);
  }

  const label = pinned ? "Unpin chat from this list" : "Pin chat in this list";
  return <>
    {pinned !== null && <button type="button" className="mtg-chat-archive" aria-label={label} title={label}
      disabled={busy} onClick={() => void toggle()}>
      {pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}
      {label}
    </button>}
    {error && <span role="alert">{error}</span>}
  </>;
}
