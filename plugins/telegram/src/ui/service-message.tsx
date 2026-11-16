import type { MouseEvent } from "react";
import type { Message } from "../core/demo.ts";

export function ServiceMessageRow({ message, openPinned }: {
  message: Message;
  openPinned?: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const id = message.pinnedTargetId;
  return <li className="mtg-service-message" data-message-id={message.id} title={message.time}>
    {id && openPinned ? <button type="button" className="mtg-open-pinned-service" aria-label="Open pinned message"
      onClick={(event) => openPinned(id, event)}>{message.text}</button> : message.text}
  </li>;
}
