import { useTelegramLocale } from "./i18n/index.tsx";
import { displayMessageText } from "./i18n/message-labels.ts";
import type { MouseEvent } from "react";
import type { Message } from "../core/demo.ts";

export function ServiceMessageRow({ message, openMessage }: {
  message: Message;
  openMessage?: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const id = message.gameScoreTargetId ?? message.pinnedTargetId;
  const text = displayMessageText(message, tr);
  const label = message.gameScoreTargetId ? tr("{0}. Open game message", [text]) : tr("Open pinned message");
  return <li className="mtg-service-message" data-context-object={id && openMessage ? true : undefined}
    data-message-id={message.id} title={message.time}>
    {message.gameScoreTargetId && message.author && <><bdi>{message.author}</bdi>{" · "}</>}
    {id && openMessage ? <button type="button" className="mtg-open-pinned-service" aria-label={label}
      onClick={(event) => openMessage(id, event)}>{text}</button> : text}
  </li>;
}
