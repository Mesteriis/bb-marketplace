import { useTelegramLocale } from "./i18n/index.tsx";
import { Pin, PinOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatList } from "../core/contract.ts";

export type ChatPinActions = {
  chatPinStatus: (id: string, list: ChatList) => Promise<boolean | null>;
  pinnedChatOrder?: (list: Exclude<ChatList, "saved">) => Promise<string[] | null>;
  movePinnedChat?: (list: Exclude<ChatList, "saved">, id: string, direction: "up" | "down", expected: string[]) => Promise<"updated" | "changed" | "refused" | "unknown">;
  setChatPinned: (id: string, list: ChatList, pinned: boolean) => Promise<"updated" | "refused" | "unknown">;
};

export function ChatPin({ id, list, revision, chatPinStatus, setChatPinned, pinnedChatOrder, movePinnedChat }: ChatPinActions & {
  id: string;
  list: ChatList;
  revision: number;
}) {
  const { t: tr } = useTelegramLocale();
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<string[]>();
  const [orderStatus, setOrderStatus] = useState("");
  const [ordering, setOrdering] = useState(false);
  const index = order?.indexOf(id) ?? -1;

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
    if (pinned === null || busy || ordering) return;
    const next = !pinned;
    setBusy(true);
    setError("");
    const result = await setChatPinned(id, list, next).catch(() => "unknown");
    if (result === "updated") {
      setPinned(next);
      setOrder(undefined);
      setOrderStatus("");
    }
    else setError(result === "refused" ? "Telegram refused to change this pin." : "Telegram did not confirm the pin.");
    setBusy(false);
  }

  async function readOrder() {
    if (!pinnedChatOrder || list === "saved" || ordering || busy) return;
    setOrdering(true);
    setOrderStatus("");
    const current = await pinnedChatOrder(list).catch(() => null);
    setOrder(current ?? undefined);
    if (!current?.includes(id)) setOrderStatus("Could not verify this chat’s pin position.");
    setOrdering(false);
  }

  async function move(direction: "up" | "down") {
    if (!movePinnedChat || list === "saved" || !order || index < 0 || ordering || busy) return;
    const to = index + (direction === "up" ? -1 : 1);
    if (to < 0 || to >= order.length) return;
    setOrdering(true);
    setOrderStatus("");
    const result = await movePinnedChat(list, id, direction, order).catch(() => "unknown");
    if (result === "updated") {
      const updated = [...order];
      [updated[index], updated[to]] = [updated[to]!, updated[index]!];
      setOrder(updated);
    } else {
      setOrder(undefined);
      setOrderStatus(result === "changed" ? "Pinned chats changed in Telegram. Reload their order."
        : "Telegram did not confirm the pin move. Reload their order.");
    }
    setOrdering(false);
  }

  const label = pinned ? tr("Unpin chat from this list") : tr("Pin chat in this list");
  return <>
    {pinned !== null && <button type="button" className="mtg-chat-archive" aria-label={label} title={label}
      disabled={busy || ordering} onClick={() => void toggle()}>
      {pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}
      {label}
    </button>}
    {pinned && pinnedChatOrder && movePinnedChat && list !== "saved" && <div className="mtg-chat-pin-order">
      {index < 0 ? <button type="button" className="mtg-action" disabled={ordering || busy} onClick={() => void readOrder()}>
        {orderStatus ? tr("Reload pinned chat order") : tr("Show pinned chat position")}
      </button> : <>
        <span role="status">{tr("Pin ")}{index + 1}{tr(" of ")}{order?.length}</span>
        <button type="button" className="mtg-action" disabled={ordering || busy || index === 0} onClick={() => void move("up")}>{tr("Move pin up")}</button>
        <button type="button" className="mtg-action" disabled={ordering || busy || index === (order?.length ?? 0) - 1} onClick={() => void move("down")}>{tr("Move pin down")}</button>
      </>}
      {orderStatus && <span role="alert">{tr(orderStatus)}</span>}
    </div>}
    {error && <span role="alert">{tr(error)}</span>}
  </>;
}
