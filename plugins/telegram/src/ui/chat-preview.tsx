import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HistoryPage } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";
import { maskSpoilers } from "../core/message-spoilers.ts";
import { displayMessagePreview } from "./i18n/message-labels.ts";
import { PhotoPreview } from "./photo-preview.tsx";
import type { RichPhotoLoader } from "./rich-message.tsx";

export function ChatPreview({ chat, load, loadPhoto, close, open }: {
  chat: Chat;
  load: (id: string) => Promise<HistoryPage>;
  loadPhoto?: RichPhotoLoader;
  close: () => void;
  open: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLUListElement>(null);
  const [page, setPage] = useState<HistoryPage>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let current = true;
    void load(chat.id).then((next) => { if (current) setPage(next); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [load, chat.id, attempt]);
  useLayoutEffect(() => {
    if (history.current && page) history.current.scrollTop = history.current.scrollHeight;
  }, [page]);

  return <dialog ref={dialog} className="mtg-agent-settings mtg-chat-preview" aria-label={tr("Chat preview")} onClose={(event) => {
    if (event.target !== event.currentTarget) return;
    event.stopPropagation();
    close();
  }}>
    <h2><bdi>{chat.name}</bdi></h2>
    {!page && !failed && <p role="status">{tr("Loading recent messages…")}</p>}
    {failed && <p role="alert">{tr("Could not load the chat preview. ")}<button type="button" className="mtg-action" onClick={() => {
      setFailed(false);
      setAttempt((value) => value + 1);
    }}>{tr("Retry")}</button></p>}
    {page && !page.messages.length && <p>{tr("No messages.")}</p>}
    {!!page?.messages.length && <ul ref={history} className="mtg-chat-preview-history" aria-label={tr("Recent messages")} tabIndex={0}>
      {page.messages.map((message) => {
        const photo = message.hasPhoto && !message.oneView && !message.retained && loadPhoto;
        const caption = message.photoCaption ?? message.document?.caption;
        const text = message.oneView ? message.oneView === "photo" ? "One-view photo" : "One-view video"
          : caption ? maskSpoilers(caption, message.styles, tr("[Spoiler]")) : photo ? undefined : displayMessagePreview(message, tr);
        return <li key={message.id} className="mtg-chat-preview-message">
          <div><strong><bdi>{message.author}</bdi></strong><time>{message.time}</time></div>
          {photo && <PhotoPreview chatId={chat.id} messageId={message.id} dimensions={message.photoDimensions}
            spoiler={message.photoSpoiler} load={photo} />}
          {text && <p><bdi>{text}</bdi></p>}
        </li>;
      })}
    </ul>}
    <div className="mtg-agent-settings-actions">
      <button type="button" className="mtg-action" onClick={() => dialog.current?.close()}>{tr("Close preview")}</button>
      <button type="button" className="mtg-action" onClick={open}>{tr("Open chat")}</button>
    </div>
  </dialog>;
}
