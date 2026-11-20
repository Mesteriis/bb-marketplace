import { useTelegramLocale } from "./i18n/index.tsx";
import { Link2 } from "lucide-react";
import { useState } from "react";
import type { MessageLinkTarget } from "../core/contract.ts";

export type MessageLinkLoader = (id: string, messageId: string, target?: MessageLinkTarget) => Promise<string | null>;

export function CopyTelegramLink({ chatId, messageId, load, kind = "message", target, itemLabel }: {
  chatId: string; messageId: string; load: MessageLinkLoader; kind?: "message" | "topic" | "story" | "story album" | "playback position";
  target?: MessageLinkTarget; itemLabel?: string;
}) {
  const { t: tr } = useTelegramLocale();
  const [status, setStatus] = useState<"busy" | "copied" | "unavailable">();
  const [link, setLink] = useState<string>();

  async function copy() {
    setStatus("busy");
    setLink(undefined);
    try {
      const url = target ? await load(chatId, messageId, target) : await load(chatId, messageId);
      if (!url) { setStatus("unavailable"); return; }
      try {
        await navigator.clipboard.writeText(url);
        setStatus("copied");
      } catch {
        setStatus(undefined);
        setLink(url);
      }
    } catch { setStatus("unavailable"); }
  }

  const label = tr("Copy Telegram {0} link", [target?.kind ?? kind]);
  return <>
    <button type="button" className="mtg-reply-action" aria-label={itemLabel ? tr("{0} for {1}", [label, itemLabel]) : label}
      title={label} disabled={status === "busy"} onClick={() => void copy()}><Link2 size={15} aria-hidden="true" /></button>
    {status === "copied" && <span role="status">{tr("Telegram link copied")}</span>}
    {status === "unavailable" && <span role="status">{tr("Telegram link unavailable")}</span>}
    {link && <input aria-label={tr("Telegram {0} link", [target?.kind ?? kind])} value={link} readOnly onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
