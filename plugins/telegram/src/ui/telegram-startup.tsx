import { Send } from "lucide-react";
import type { ReactNode } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";

export function TelegramStartup({ status, children }: { status?: string; children?: ReactNode }) {
  const { locale, t: tr } = useTelegramLocale();
  return <div lang={locale} data-bb-ru-skip className="mtg mtg-login">
    <section aria-labelledby="telegram-sign-in" data-loading={status ? true : undefined}>
      <div className="mtg-startup-mark" aria-hidden="true"><Send size={28} strokeWidth={1.7} /></div>
      <h1 id="telegram-sign-in">{status ? "Telegram" : tr("Connect Telegram")}</h1>
      {status && <div className="mtg-startup-status" role="status">
        <span>{tr(status)}</span>
        <span className="mtg-startup-track" aria-hidden="true"><span /></span>
      </div>}
      {children}
    </section>
  </div>;
}
