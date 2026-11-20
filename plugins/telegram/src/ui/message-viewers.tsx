import { useTelegramLocale } from "./i18n/index.tsx";
import { Users } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MessageViewer } from "../core/contract.ts";
import type { Message } from "../core/demo.ts";
import { Avatar, type AvatarLoader } from "./avatar.tsx";
import { isPlainKey } from "./composer-keys.ts";

export type MessageViewerLoader = (chatId: string, messageId: string) => Promise<MessageViewer[] | null>;

type OpenViewer = (chatId: string, messageId: string, userId: string, signal: AbortSignal) => Promise<boolean>;
const ViewerScope = createContext<{
  claim: (close: () => void) => () => void;
  openViewer?: OpenViewer;
} | null>(null);

export function MessageViewerScope({ children, openViewer }: { children: ReactNode; openViewer?: OpenViewer }) {
  const active = useRef<(() => void) | undefined>(undefined);
  const claim = useCallback((close: () => void) => {
    active.current?.();
    active.current = close;
    return () => { if (active.current === close) active.current = undefined; };
  }, []);
  return <ViewerScope.Provider value={{ claim, openViewer }}>{children}</ViewerScope.Provider>;
}

export function MessageViewerAction({ chatId, message, load, loadAvatar }: {
  chatId: string; message: Message; load?: MessageViewerLoader; loadAvatar?: AvatarLoader;
}) {
  return <div className="mtg-message-viewer-slot">
    {load && message.outgoing && !message.retained && !message.pendingDelivery && /^[1-9]\d{0,15}$/.test(message.id)
      && <MessageViewers key={`${chatId}:${message.id}`} chatId={chatId} messageId={message.id} load={load} loadAvatar={loadAvatar} />}
  </div>;
}

export function MessageViewers({ chatId, messageId, load, loadAvatar }: {
  chatId: string;
  messageId: string;
  load: MessageViewerLoader;
  loadAvatar?: AvatarLoader;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const panel = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const scope = useContext(ViewerScope);
  const release = useRef<(() => void) | undefined>(undefined);
  const request = useRef<symbol | undefined>(undefined);
  const profileRequest = useRef<AbortController | undefined>(undefined);
  const [profile, setProfile] = useState<"opening" | "unavailable">();
  const [state, setState] = useState<
    { kind: "closed" | "loading" | "error" } | { kind: "ready"; viewers: MessageViewer[] | null }
  >({ kind: "closed" });
  const expanded = state.kind !== "closed";
  const viewers = state.kind === "ready" ? state.viewers : undefined;

  useEffect(() => () => {
    request.current = undefined;
    profileRequest.current?.abort();
    release.current?.();
  }, []);

  function close() {
    release.current?.();
    release.current = undefined;
    request.current = undefined;
    profileRequest.current?.abort();
    profileRequest.current = undefined;
    setProfile(undefined);
    if (dialog.current?.open) dialog.current.close();
    setState({ kind: "closed" });
  }

  function dismiss() {
    close();
    trigger.current?.focus({ preventScroll: true });
  }

  async function open() {
    release.current?.();
    release.current = scope?.claim(close);
    const attempt = Symbol();
    request.current = attempt;
    setState({ kind: "loading" });
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    try {
      const viewers = await load(chatId, messageId);
      if (request.current === attempt) setState({ kind: "ready", viewers });
    } catch {
      if (request.current === attempt) setState({ kind: "error" });
    }
  }

  async function openProfile(userId: string) {
    if (!scope?.openViewer || profileRequest.current) return;
    const controller = new AbortController();
    profileRequest.current = controller;
    setProfile("opening");
    const opened = await scope.openViewer(chatId, messageId, userId, controller.signal).catch(() => false);
    if (controller.signal.aborted) return;
    profileRequest.current = undefined;
    if (opened) close();
    else setProfile("unavailable");
  }

  return <div className="mtg-message-viewers" onKeyDown={(event) => {
    if (!expanded || !isPlainKey(event, "Escape")) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }}>
    <button ref={trigger} type="button" className="mtg-reply-action" title={tr("Who viewed this message")}
      aria-label={tr("Who viewed this message")} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={panel}
      onClick={() => expanded ? dismiss() : void open()}><Users size={15} aria-hidden="true" /></button>
    <dialog ref={dialog} id={panel} className="mtg-instant-view mtg-message-viewer-dialog" aria-label={tr("Who viewed this message")}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}>
      <header>
        <h2>{tr("Who viewed this message")}</h2>
        <button type="button" className="mtg-action" onClick={dismiss}>{tr("Close viewers")}</button>
      </header>
      <div className="mtg-message-viewers-list"
        tabIndex={viewers?.length ? 0 : undefined} role="region" aria-label={tr("Message viewer details")}>
        {state.kind === "loading" && <p role="status">{tr("Loading message viewers…")}</p>}
        {state.kind === "error" && <>
          <p role="alert">{tr("Could not load message viewers.")}</p>
          <button type="button" className="mtg-action" onClick={() => void open()}>{tr("Retry")}</button>
        </>}
        {viewers === null && <p role="status">{tr("Telegram does not provide a viewer list for this message.")}</p>}
        {viewers?.length === 0 && <p role="status">{tr("No recorded viewers yet.")}</p>}
        {!!viewers?.length && <ul aria-label={tr("Message viewers")}>
          {viewers.map(({ id, name, viewedAt, avatarJpeg, avatarFileId }) => {
            const date = viewedAt ? new Date(viewedAt * 1000) : undefined;
            const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
            return <li key={id}>
              <Avatar chat={{ id, initials, color: "#246dbd", avatarJpeg, avatarFileId }} user load={loadAvatar} />
              <div className="mtg-viewer-identity">
                {scope?.openViewer ? <button type="button" className="mtg-author-search" aria-label={tr("Open profile of {0}", [name])}
                  disabled={profile === "opening"} onClick={() => void openProfile(id)}><bdi>{name}</bdi></button>
                  : <bdi>{name}</bdi>}
                {date && <time dateTime={date.toISOString()}>{date.toLocaleString(uiLocale)}</time>}
              </div>
            </li>;
          })}
        </ul>}
        {profile === "opening" && <p role="status">{tr("Opening profile…")}</p>}
        {profile === "unavailable" && <p role="status">{tr("Could not open this profile. The read receipt or profile may no longer be available.")}</p>}
      </div>
    </dialog>
  </div>;
}
