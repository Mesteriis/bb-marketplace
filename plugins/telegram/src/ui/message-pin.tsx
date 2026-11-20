import { useTelegramLocale } from "./i18n/index.tsx";
import { Pin } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ForumTopicTarget, MessagePinMode } from "../core/contract.ts";

export type MessagePinActions = {
  pinStatus: (id: string, messageId: string) => Promise<boolean | null>;
  setMessagePinned: (id: string, messageId: string, pinned: boolean, mode?: MessagePinMode) => Promise<"updated" | "refused" | "unknown">;
};

export function MessagePin({ chatId, messageId, pinStatus, setMessagePinned, inTopic = false, extraMode, onlyUnpin = false, onUnpinned }: MessagePinActions & {
  chatId: string;
  messageId: string;
  inTopic?: boolean;
  extraMode?: MessagePinMode;
  onlyUnpin?: boolean;
  onUnpinned?: (restoreFocus: boolean) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [prompt, setPrompt] = useState<{ pinned?: boolean; busy?: boolean; status?: string }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  function canRestoreFocus() {
    const active = document.activeElement;
    return restoreFocus.current && (active === document.body || active === trigger.current || !!panel.current?.contains(active));
  }

  useLayoutEffect(() => {
    if (prompt?.busy) return;
    if (canRestoreFocus()) {
      (prompt ? panel.current?.querySelector<HTMLButtonElement>("button") : trigger.current)?.focus({ preventScroll: true });
    }
    restoreFocus.current = false;
  }, [prompt]);

  async function open() {
    restoreFocus.current = document.activeElement === trigger.current;
    setPrompt({ busy: true, status: "Checking pin options…" });
    try {
      const pinned = await pinStatus(chatId, messageId);
      if (pinned === false && onlyUnpin) {
        onUnpinned?.(canRestoreFocus());
        setPrompt({ status: "This message is no longer pinned." });
        return;
      }
      setPrompt(pinned === null ? { status: "You can’t manage this pin in Telegram." } : { pinned });
    } catch {
      setPrompt({ status: "Could not check this pin in Telegram." });
    }
  }

  async function change(pinned: boolean, mode?: MessagePinMode) {
    restoreFocus.current = !!panel.current?.contains(document.activeElement);
    setPrompt({ busy: true, status: "Updating pinned message…" });
    const result = await (mode ? setMessagePinned(chatId, messageId, pinned, mode)
      : setMessagePinned(chatId, messageId, pinned)).catch(() => "unknown");
    if (!pinned && result === "updated") onUnpinned?.(canRestoreFocus());
    setPrompt({ status: result === "updated" ? pinned ? (mode === "self" ? "Message pinned for you." : "Message pinned.") : "Message unpinned."
      : result === "refused" ? "Telegram refused to update the pin."
      : "Telegram did not confirm the update." });
  }

  if (!prompt) return <button ref={trigger} type="button" className="mtg-reply-action" aria-label={tr("Manage message pin")} data-message-pin
    title={tr("Manage message pin")} onClick={() => void open()}><Pin size={15} aria-hidden="true" /></button>;

  return <div ref={panel} className="mtg-edit" role="group" aria-label={tr("Message pin")}>
    {prompt.status && <p role="status">{prompt.status}</p>}
    <div className="mtg-message-pin-actions">
      {prompt.pinned !== undefined && <button type="button" className="mtg-action"
        onClick={() => void change(!prompt.pinned)}>{prompt.pinned ? (inTopic ? tr("Unpin from topic") : tr("Unpin from chat")) : (inTopic ? tr("Pin in topic") : tr("Pin in chat"))}</button>}
      {prompt.pinned === false && extraMode && <button type="button" className="mtg-action"
        onClick={() => void change(true, extraMode)}>{extraMode === "self" ? tr("Pin for me") : tr("Pin and notify")}</button>}
      {!prompt.busy && <button type="button" className="mtg-action"
        onClick={() => {
          restoreFocus.current = !!panel.current?.contains(document.activeElement);
          setPrompt(undefined);
        }}>{prompt.pinned === undefined ? tr("Close") : tr("Cancel")}</button>}
    </div>
  </div>;
}


export type BulkUnpinActions = {
  preview: (id: string, topic?: ForumTopicTarget) => Promise<string | null>;
  unpin: (id: string, messageId: string, topic?: ForumTopicTarget) => Promise<"updated" | "changed" | "refused" | "unknown">;
};

export function BulkUnpin({ chatId, topic, conversationName = topic?.name, actions, hasPins, refresh }: {
  chatId: string;
  topic?: ForumTopicTarget;
  conversationName?: string;
  actions: BulkUnpinActions;
  hasPins: boolean;
  refresh: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [anchor, setAnchor] = useState<string>();
  const [status, setStatus] = useState<"checking" | "updating" | "unavailable" | "updated" | "changed" | "refused" | "unknown">();
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const busy = status === "checking" || status === "updating";

  async function review() {
    if (pending.current) return;
    pending.current = true;
    setStatus("checking");
    try {
      const found = await actions.preview(chatId, topic);
      setAnchor(found ?? undefined);
      setStatus(found ? undefined : "unavailable");
    } catch {
      setStatus("unavailable");
    } finally {
      pending.current = false;
    }
  }

  async function confirm() {
    if (!anchor || pending.current) return;
    pending.current = true;
    setStatus("updating");
    setAnchor(undefined);
    try {
      const result = await actions.unpin(chatId, anchor, topic);
      setStatus(result);
      if (mounted.current && (result === "updated" || result === "changed")) refresh();
    } catch {
      setStatus("unknown");
    } finally {
      pending.current = false;
    }
  }

  return <>
    {hasPins && !anchor && <button type="button" className="mtg-action" disabled={busy} onClick={() => void review()}>{tr("Unpin all messages")}</button>}
    {anchor && <div className="mtg-edit" role="group" aria-label={tr("Confirm removing pinned messages")}>
      <p>{conversationName ? <>{tr("Unpin all messages in “")}<bdi>{conversationName}</bdi>”?</> : tr("Unpin all messages in this chat?")}</p>
      <button type="button" className="mtg-action" onClick={() => setAnchor(undefined)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" onClick={() => void confirm()}>{tr("Confirm unpin all")}</button>
    </div>}
    {status && <p role="status">{
      status === "checking" ? tr("Checking pinned messages…") : status === "updating" ? tr("Removing pinned messages…")
      : status === "unavailable" ? tr("Bulk unpin is unavailable for this conversation.")
      : status === "updated" ? tr("All messages unpinned.")
      : status === "changed" ? tr("Pins or permissions changed. Review the list again.")
      : status === "refused" ? tr("Telegram refused to remove the pins.")
      : tr("Telegram did not confirm the change. Check the pins before retrying.")
    }</p>}
  </>;
}
