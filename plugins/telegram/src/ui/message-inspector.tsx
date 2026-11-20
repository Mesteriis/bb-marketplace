import { useTelegramLocale } from "./i18n/index.tsx";
import { X } from "lucide-react";
import { createContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../components/ui/button.tsx";
import type { Message } from "../core/demo.ts";
import { CopyMessageReference } from "./copy-message-reference.tsx";

type Selection = { message: Message; trigger: HTMLButtonElement; chatId?: string };
type SidePanel = { details: HTMLElement | null; openDetails: () => boolean };
type Inspector = { selected?: HTMLButtonElement; toggle: (message: Message, trigger: HTMLButtonElement, chatId?: string) => void };
export const MessageInspectorAction = createContext<Inspector | undefined>(undefined);

export function MessageInspector({ scope, workspace, children }: { scope: string; workspace?: SidePanel; children: ReactNode }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [selected, setSelected] = useState<Selection>();
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const details = workspace?.details;
  useEffect(() => setSelected(undefined), [scope]);
  useLayoutEffect(() => {
    if (selected) closeButton.current?.focus({ preventScroll: true });
  }, [details, selected]);

  function close() {
    setSelected(undefined);
    selected?.trigger.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!selected) return;
    const observer = typeof MutationObserver === "function" && new MutationObserver(() => {
      if (!selected.trigger.isConnected) setSelected(undefined);
    });
    const conversation = selected.trigger.closest(".mtg-conversation");
    if (observer && conversation) observer.observe(conversation, { childList: true, subtree: true });
    function outside(event: PointerEvent) {
      if (details || !(event.target instanceof Node) || panel.current?.contains(event.target) ||
        selected?.trigger.contains(event.target)) return;
      setSelected(undefined);
    }
    document.addEventListener("pointerdown", outside, true);
    return () => { if (observer) observer.disconnect(); document.removeEventListener("pointerdown", outside, true); };
  }, [details, selected]);

  const message = selected?.message;
  const inspector = message && <section className={details ? "mtg-chat-inspector" : "mtg-message-info-sheet"}
    ref={panel} data-message-inspector aria-label={tr("Message information")}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <header><h2>{tr("Message information")}</h2>
      <Button ref={closeButton} type="button" variant="ghost" size="icon" aria-label={tr("Close message information")}
        onClick={close}><X size={17} aria-hidden="true" /></Button>
    </header>
    <dl>
      {message.author && <div><dt>{tr("Author")}</dt><dd><bdi>{message.author}</bdi></dd></div>}
      {(message.time || message.timestamp) && <div><dt>{tr("Sent")}</dt><dd>{message.time || new Date(message.timestamp! * 1000).toLocaleString(uiLocale)}</dd></div>}
      {message.edited && <div><dt>{tr("Edited")}</dt><dd>{message.editedAt ? new Date(message.editedAt * 1000).toLocaleString(uiLocale) : tr("Edited")}</dd></div>}
      {message.viewCount !== undefined && <div><dt>{tr("Views")}</dt><dd>{message.viewCount.toLocaleString(uiLocale)}</dd></div>}
      {message.channelSignature && <div><dt>{tr("Signature")}</dt><dd><bdi>{message.channelSignature}</bdi></dd></div>}
      {message.retained && <div><dt>{tr("Status")}</dt><dd>{message.retained === "expired" ? tr("Media expired · kept locally") : tr("Deleted in Telegram · kept locally")}</dd></div>}
    </dl>
    {selected?.chatId && !message.retained && !message.pendingDelivery && <CopyMessageReference
      chatId={selected.chatId} messageId={message.id} forumTopicId={message.forumTopicId} />}
  </section>;

  return <MessageInspectorAction.Provider value={{ selected: selected?.trigger, toggle: (message, trigger, chatId) => {
    if (selected?.trigger === trigger) { close(); return; }
    workspace?.openDetails();
    setSelected({ message, trigger, chatId });
  } }}>
    {children}
    {inspector && (details ? createPortal(inspector, details) : inspector)}
  </MessageInspectorAction.Provider>;
}
