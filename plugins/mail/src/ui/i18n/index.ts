// Mail's pages in the owner's language (slice 3j, #53). English is the
// source: `t("Load more")` returns the text as written, and in Russian the
// entry of `ru.ts` under that same text. A text with no entry stays English,
// so a missing translation never breaks a page. Values go in by name
// (`t("Synced {when}", { when })`) and are inserted as text, never as markup;
// mail data (subjects, names, folders) is passed as a value, never as a key.
//
// The language is one value for the page (set by `app.tsx` from the
// `language` setting before it renders), so plain helpers can call `t` too.
import { RU } from "./ru.ts";

export type Language = "en" | "ru";

/** The forms of a counted text: `one` (1, 21), `few` (2-4), `many` (5-20); English uses `one` and `other`. */
export type PluralForms = { one: string; few?: string; many?: string; other: string };
export type CatalogEntry = string | PluralForms;
export type Catalog = Readonly<Record<string, CatalogEntry>>;

const CATALOGS: Record<Language, Catalog> = { en: {}, ru: RU };

let current: Language = "en";

export function setLanguage(language: Language): void {
  current = language;
}

export function getLanguage(): Language {
  return current;
}

/** The `language` setting and the system's languages as the page's language. */
export function resolveLanguage(setting: unknown, system: readonly string[]): Language {
  if (setting === "ru" || setting === "en") return setting;
  return system.some((tag) => /^ru\b/i.test(tag)) ? "ru" : "en";
}

/** The BCP 47 tag for dates and numbers in the page's language. */
export function dateLocale(): string {
  return current === "ru" ? "ru-RU" : "en-US";
}

export type Params = Readonly<Record<string, string | number>>;

function fill(text: string, params: Params | undefined): string {
  if (params === undefined) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

const pluralRules = new Map<Language, Intl.PluralRules>();

function formOf(forms: PluralForms, count: number): string {
  let rules = pluralRules.get(current);
  if (rules === undefined) {
    rules = new Intl.PluralRules(current === "ru" ? "ru" : "en");
    pluralRules.set(current, rules);
  }
  const category = rules.select(count);
  if (category === "one") return forms.one;
  if (category === "few") return forms.few ?? forms.other;
  if (category === "many") return forms.many ?? forms.other;
  return forms.other;
}

/**
 * `text` in the page's language. A counted entry picks its form by the
 * `count` value (or `n`). Unknown text comes back as written.
 */
export function t(text: string, params?: Params): string {
  const entry = current === "en" ? undefined : CATALOGS[current][text];
  if (entry === undefined) return fill(text, params);
  if (typeof entry === "string") return fill(entry, params);
  const count = Number(params?.count ?? params?.n ?? 0);
  return fill(formOf(entry, Number.isFinite(count) ? count : 0), params);
}

/**
 * A counted English text: `tn(3, "{count} message", "{count} messages")`.
 * The catalog is keyed by the plural form.
 */
export function tn(count: number, one: string, other: string, params?: Params): string {
  const all = { ...params, count };
  if (current === "en") return fill(count === 1 ? one : other, all);
  return t(other, all);
}

/**
 * Marks a text for the catalog where it is defined but shown later
 * (a table of labels): returns it unchanged. Show it with `t(label)`.
 */
export function msg(text: string): string {
  return text;
}

/** `t` under the name the pages import: many of them already use `t` for a thread. */
export const tx = t;
export const txn = tn;
