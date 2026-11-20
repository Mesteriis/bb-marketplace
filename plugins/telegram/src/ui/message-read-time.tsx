import { useTelegramLocale } from "./i18n/index.tsx";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import type { MessageReadTime } from "../core/contract.ts";

export type ReadTimeLoader = (chatId: string, messageId: string) => Promise<MessageReadTime>;

const labels = {
  unavailable: "Read time unavailable",
  unread: "Telegram reports this message as unread",
  tooOld: "This message is too old to show the read time",
  recipientPrivacy: "The recipient hides their read time",
  ownPrivacy: "Your privacy settings limit access to read times",
};

export function ReadTimeButton({ chatId, messageId, load }: { chatId: string; messageId: string; load: ReadTimeLoader }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    if (status) {
      setStatus("");
      return;
    }
    setBusy(true);
    try {
      const result = await load(chatId, messageId);
      setStatus(typeof result === "number" ? tr("Read {0}", [new Date(result * 1000).toLocaleString(uiLocale)]) : labels[result]);
    } catch {
      setStatus("Could not load the read time");
    } finally {
      setBusy(false);
    }
  }

  return <>
    {busy ? <span role="status">{tr("Loading read time…")}</span> : status && <span role="status">{tr(status)}</span>}
    <button type="button" className="mtg-reply-action" title={tr("Show read time")}
      aria-label={status ? tr("Hide read time") : tr("Show read time")} aria-expanded={!!status || busy}
      disabled={busy} onClick={() => void toggle()}><CheckCheck size={14} aria-hidden="true" /></button>
  </>;
}
