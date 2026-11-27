import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { format, type Language, type LanguageSetting, type Values } from "../../core/i18n/language.ts";

type LanguageState = {language: Language; setting: LanguageSetting; choose(setting: LanguageSetting): void};
const LanguageContext = createContext<LanguageState>({language: "en", setting: "auto", choose: () => {}});

/** Gives the subtree its language; the app resolves it from the setting and BB's language. */
export function LanguageProvider({language, setting, choose, children}: LanguageState & {children: ReactNode}) {
  const value = useMemo(() => ({language, setting, choose}), [language, setting, choose]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageState {
  return useContext(LanguageContext);
}

/** `t(key, values)` in the current language. */
export function useT(): (key: MessageKey, values?: Values) => string {
  const {language} = useContext(LanguageContext);
  return useMemo(() => (key: MessageKey, values?: Values) => format(language, key, values), [language]);
}
