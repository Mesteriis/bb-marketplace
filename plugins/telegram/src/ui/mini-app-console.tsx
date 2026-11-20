import { useEffect, useState } from "react";
import { SquareTerminal, X } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { useTelegramLocale } from "./i18n/index.tsx";

export type MiniAppConsoleEvent = {
  id: number;
  at: number;
  direction: "app" | "bb" | "frame";
  name: string;
};

// Log only known event names. Payloads may contain Telegram authorization data.
export const miniAppConsoleEvents = new Set([
  "web_app_ready", "web_app_setup_main_button", "web_app_setup_secondary_button",
  "web_app_setup_back_button", "web_app_setup_settings_button", "web_app_request_viewport",
  "web_app_request_theme", "web_app_request_safe_area", "web_app_request_content_safe_area",
  "web_app_expand", "web_app_request_fullscreen", "web_app_exit_fullscreen", "web_app_close",
  "web_app_open_link", "web_app_open_tg_link", "web_app_data_send", "web_app_invoke_custom_method",
  "viewport_changed", "theme_changed", "safe_area_changed", "content_safe_area_changed",
  "visibility_changed", "fullscreen_changed", "fullscreen_failed", "back_button_pressed",
  "settings_button_pressed", "main_button_pressed", "secondary_button_pressed", "reload_iframe",
]);

export function MiniAppConsole({ origin, read, clear, close }: {
  origin: string;
  read: () => readonly MiniAppConsoleEvent[];
  clear: () => void;
  close: () => void;
}) {
  const { t, locale } = useTelegramLocale();
  const [events, setEvents] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setEvents(read()), 250);
    return () => clearInterval(timer);
  }, [read]);

  return <section className="mtg-mini-app-console" aria-label={t("WebApp event console")}>
    <div className="mtg-mini-app-console-bar">
      <SquareTerminal size={17} aria-hidden="true" />
      <h2>{t("WebApp event console")}</h2>
      <Button type="button" size="sm" variant="ghost" onClick={() => { clear(); setEvents(read()); }}>{t("Clear log")}</Button>
      <Button type="button" size="icon" variant="ghost" aria-label={t("Close WebApp console")} onClick={close}><X size={17} aria-hidden="true" /></Button>
    </div>
    <p className="mtg-mini-app-console-origin">
      {t("WebApp frame")} <code>{origin}</code>
      <span>{t("For JavaScript logs, select this frame in the browser’s DevTools console.")}</span>
    </p>
    {events.length === 0 ? <p className="mtg-mini-app-console-empty">{t("No WebApp events yet.")}</p>
      : <ol className="mtg-mini-app-console-log" tabIndex={0} aria-label={t("WebApp events")}>
        {events.map(({ id, at, direction, name }) => <li key={id}>
          <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString(locale)}</time>
          <span>{direction === "app" ? "WebApp → BB" : direction === "bb" ? "BB → WebApp" : t("WebApp frame")}</span>
          <code>{direction === "frame" ? t(name) : name}</code>
        </li>)}
      </ol>}
  </section>;
}
