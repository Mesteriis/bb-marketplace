import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import russian from "./ru.json";

export type TelegramLanguage = "en" | "ru";
type Translated<T> = T extends string ? string : T;
export type Translate = <T>(message: T, values?: readonly unknown[]) => Translated<T>;

export function resolveTelegramLanguage(preference: unknown, system: readonly string[], shell?: string): TelegramLanguage {
  if (preference === "en" || preference === "ru") return preference;
  // BB's stock shell uses `en` even when the device prefers another language.
  if (shell && /^ru(?:[-_]|$)/i.test(shell)) return "ru";
  for (const tag of system) {
    const language = tag.toLowerCase().split(/[-_]/)[0];
    if (language === "ru" || language === "en") return language;
  }
  return "en";
}

const messages: Readonly<Record<string, string>> = russian;

export function makeTelegramTranslator(language: TelegramLanguage): Translate {
  return <T,>(message: T, values?: readonly unknown[]): Translated<T> => {
    if (typeof message !== "string") return message as Translated<T>;
    const key = message.trim().replace(/\s+/g, " ");
    const translated = language === "ru" && Object.hasOwn(messages, key)
      ? message.replace(/\S[\s\S]*\S|\S/u, () => messages[key]!) : message;
    return (values ? translated.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
      Number(index) < values.length ? String(values[Number(index)]) : placeholder) : translated) as Translated<T>;
  };
}

const english = { locale: "en" as const, t: makeTelegramTranslator("en") };
const Locale = createContext<{ locale: TelegramLanguage; t: Translate }>(english);
export function useTelegramLocale() { return useContext(Locale); }

function subscribe(listener: () => void) {
  window.addEventListener("languagechange", listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return () => {
    observer.disconnect();
    window.removeEventListener("languagechange", listener);
  };
}

function systemLanguage() {
  return resolveTelegramLanguage("auto", navigator.languages?.length ? navigator.languages : [navigator.language], document.documentElement.lang);
}

export function TelegramLocaleProvider({ preference, children }: { preference?: unknown; children: ReactNode }) {
  const system = useSyncExternalStore(subscribe, systemLanguage, () => "en" as const);
  const locale = preference === "ru" || preference === "en" ? preference : system;
  const value = useMemo(() => ({ locale, t: makeTelegramTranslator(locale) }), [locale]);
  return <Locale.Provider value={value}>{children}</Locale.Provider>;
}
