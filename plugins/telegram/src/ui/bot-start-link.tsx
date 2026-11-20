import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import type { BotStartResult, BotStartTarget } from "../core/contract.ts";

export function BotStartLink({ target, start, open }: {
  target: BotStartTarget;
  start: () => Promise<BotStartResult>;
  open: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const panel = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [status, setStatus] = useState<BotStartResult | "pending">();

  async function submit() {
    if (inFlight.current || status !== undefined) return;
    inFlight.current = true;
    setStatus("pending");
    const result = await start().catch(() => "unknown" as const);
    inFlight.current = false;
    if (!panel.current?.isConnected) return;
    setStatus(result);
    if (result === "sent") open();
  }

  return <div ref={panel} className="mtg-composer-media" role="group" aria-label={tr("Telegram bot link")}>
    <strong>{target.chat.name}</strong>
    <span>@{target.username}</span>
    <button type="button" className="mtg-action" disabled={status === "pending"} onClick={open}>{tr("Open bot chat")}</button>
    {status === undefined && <button type="button" className="mtg-action" onClick={() => void submit()}>{tr("Start bot from link")}</button>}
    {status === "pending" && <p role="status">{tr("Starting bot…")}</p>}
    {status === "changed" && <p role="status">{tr("The bot link changed. Search for it again.")}</p>}
    {status === "failed" && <p role="status">{tr("Could not start the bot.")}</p>}
    {status === "unknown" && <p role="status">{tr("Telegram did not confirm the start. Check the bot chat.")}</p>}
    {status === "sent" && <p role="status">{tr("Bot start sent.")}</p>}
  </div>;
}
