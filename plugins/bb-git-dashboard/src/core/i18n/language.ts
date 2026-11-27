import { en, ru, type MessageKey } from "./dictionary.ts";

export type Language = "ru" | "en";
export type LanguageSetting = "auto" | Language;
export type Values = Record<string, string | number>;

/** The interface language: the setting when it names one, otherwise BB's own language (Russian for ru-*, else English). */
export function resolveLanguage(setting: string | undefined, bbLanguage: string | undefined): Language {
  if (setting === "ru" || setting === "en") return setting;
  return /^ru\b/i.test(bbLanguage ?? "") ? "ru" : "en";
}

function plural(language: Language, n: number, forms: string[]): string {
  if (language === "en") return (n === 1 ? forms[0] : forms[1] ?? forms[0]) ?? "";
  const tens = Math.abs(n) % 100, ones = Math.abs(n) % 10;
  const index = ones === 1 && tens !== 11 ? 0 : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 1 : 2;
  return forms[index] ?? forms[forms.length - 1] ?? "";
}

/** A string of the dictionary with its values; a value that is not given stays as `{name}`, so the gap shows. */
export function format(language: Language, key: MessageKey, values: Values = {}): string {
  const text = (language === "ru" ? ru : en)[key];
  return text.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (whole, name: string, forms?: string) => {
    const value = values[name];
    if (value === undefined) return whole.replace(/\|.*\}$/, "}");
    if (forms === undefined) return String(value);
    return value + " " + plural(language, Number(value), forms.split("|"));
  });
}
