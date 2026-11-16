import type { Message } from "../core/demo.ts";

export function MessageTimestamp({ message }: {
  message: Pick<Message, "time" | "edited" | "editedAt" | "channelSignature">;
}) {
  const editDate = message.editedAt ? new Date(message.editedAt * 1000) : undefined;
  return <>
    {message.channelSignature && <span className="mtg-channel-signature" title={message.channelSignature}>
      {message.channelSignature}
    </span>}
    {message.edited && (editDate
      ? <time dateTime={editDate.toISOString()} title={`Edited ${editDate.toLocaleString()}`}>edited</time>
      : <span>edited</span>)}
    {message.time && <time>{message.time}</time>}
  </>;
}
