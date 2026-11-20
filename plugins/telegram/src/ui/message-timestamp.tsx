import { useTelegramLocale } from "./i18n/index.tsx";
import type { Message } from "../core/demo.ts";

const clocks = {
  en: new Intl.DateTimeFormat("en", { timeStyle: "short" }),
  ru: new Intl.DateTimeFormat("ru", { timeStyle: "short" }),
};

export function MessageTimestamp({ message, compact }: {
  message: Pick<Message, "time" | "timestamp" | "edited" | "editedAt" | "channelSignature">;
  compact?: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const editDate = message.editedAt ? new Date(message.editedAt * 1000) : undefined;
  const date = compact && message.timestamp ? new Date(message.timestamp * 1000) : undefined;
  return <>
    {message.channelSignature && <span className="mtg-channel-signature" title={message.channelSignature}>
      {message.channelSignature}
    </span>}
    {message.edited && (editDate
      ? <time dateTime={editDate.toISOString()} title={tr("Edited {0}", [editDate.toLocaleString(uiLocale)])}>{tr("edited")}</time>
      : <span>{tr("edited")}</span>)}
    {date && Number.isFinite(date.getTime())
      ? <time dateTime={date.toISOString()} title={date.toLocaleString(uiLocale)}>{clocks[uiLocale].format(date)}</time>
      : message.time && <time>{message.time}</time>}
  </>;
}
