import { useTelegramLocale } from "./i18n/index.tsx";
import { createContext, useContext, useRef, useState } from "react";
import { StaticTelegramMarkup } from "./static-telegram-markup.tsx";

export const LoadBotWidgetPreview = createContext<((chatId: string, messageId: string) => Promise<{ html: string } | null>) | undefined>(undefined);

export function BotWidgetPreview({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t: tr } = useTelegramLocale();
  const load = useContext(LoadBotWidgetPreview);
  const [preview, setPreview] = useState<{ html: string } | "loading" | "unavailable">();
  const loading = useRef(false);
  if (!load) return null;
  const shown = typeof preview === "object";
  return <div className="mtg-bot-widget">
    <button type="button" className="mtg-action" aria-expanded={shown} disabled={preview === "loading"} onClick={() => {
      if (shown) {
        setPreview(undefined);
        return;
      }
      if (loading.current) return;
      loading.current = true;
      setPreview("loading");
      void load(chatId, messageId).then((result) => setPreview(result ?? "unavailable"), () => setPreview("unavailable"))
        .finally(() => { loading.current = false; });
    }}>{shown ? tr("Hide widget preview") : tr("Show widget preview")}</button>
    {preview === "loading" && <p role="status">{tr("Loading widget preview…")}</p>}
    {preview === "unavailable" && <p role="status">{tr("Widget preview is unavailable.")}</p>}
    {shown && <StaticTelegramMarkup html={preview.html} className="mtg-instant-view-static-embed"
      empty={<p role="status">{tr("This widget has no static content to preview.")}</p>} />}
  </div>;
}
