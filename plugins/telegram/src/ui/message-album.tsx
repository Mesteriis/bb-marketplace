import type { ReactNode } from "react";
import type { Message } from "../core/demo.ts";
import { MessageText } from "./message-text.tsx";

export function sharedAlbumCaption(messages: readonly Message[]) {
  if (messages.length < 2 || !messages[0]?.albumId) return;
  const captions = messages.flatMap((message) => {
    const text = message.photoCaption ?? message.document?.caption;
    return text?.trim() ? [{ message, text }] : [];
  });
  if (captions.length === 1) return captions[0];
}

export function MessageAlbum({ first, caption, children }: {
  first: Message;
  caption: ReturnType<typeof sharedAlbumCaption>;
  children: ReactNode;
}) {
  const text = caption && <div className="mtg-album-caption">
    <MessageText text={caption.text} links={caption.message.links} styles={caption.message.styles} />
  </div>;
  return <li className={`mtg-album${first.outgoing ? " mtg-outgoing" : ""}`}>
    <div className="mtg-album-body">
      {caption?.message.captionAboveMedia && text}
      <ol aria-label="Media album">{children}</ol>
      {caption && !caption.message.captionAboveMedia && text}
    </div>
  </li>;
}
