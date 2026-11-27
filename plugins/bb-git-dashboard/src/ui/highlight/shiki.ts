import type { HighlighterCore, ThemedToken } from "shiki/core";
import type { LanguageId } from "../../core/highlight/plan.ts";

/** BB's code theme as a VS Code theme document (what `experimental_useCodeTheme` gives the app). */
export type CodeTheme = {name: string; type: "dark" | "light"; fg: string; bg: string; colors: Readonly<Record<string, string>>;
  tokenColors: readonly {scope?: string | readonly string[]; settings: {foreground?: string; background?: string; fontStyle?: string}}[]};
export type Token = {content: string; color?: string; fontStyle?: number};

/** Lines longer than this stay plain: minified code is slow to tokenize and unreadable either way. */
const MAX_LINE = 1_000;
/** Milliseconds Shiki may spend on one line before the rest of it stays plain, so a pathological line never stalls a diff. */
export const TIME_LIMIT = 500;
let core: Promise<HighlighterCore> | null = null;
const themes = new Map<CodeTheme, string>();
let themeCount = 0;
const grammarLoads = new Map<LanguageId, Promise<void>>();
const warmed = new Set<LanguageId>();
/** A short line every grammar starts on: tokenizing it compiles a grammar's root patterns, with no time limit. */
const WARM_UP = "x = 1";

/** The highlighter, created on first use: Shiki and its JavaScript regex engine load only when a diff is shown. */
function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")])
    .then(([{createHighlighterCore}, {createJavaScriptRegexEngine}]) => createHighlighterCore({engine: createJavaScriptRegexEngine({forgiving: true})}))
    .catch(error => { core = null; throw error; });
  return core;
}

/**
 * Each line of `code` as coloured tokens in BB's code theme, the grammar fetched through `grammar` on first use. Rejects when Shiki,
 * the grammar or the theme cannot be loaded; the caller then shows the code plain.
 */
export async function tokenize(code: string, language: LanguageId, theme: CodeTheme, grammar: (id: LanguageId) => Promise<unknown>,
  {timeLimit = TIME_LIMIT}: {timeLimit?: number} = {}): Promise<Token[][]> {
  const shiki = await highlighter();
  if (!shiki.getLoadedLanguages().includes(language)) {
    // One request per language, shared by every diff that waits for it.
    let pending = grammarLoads.get(language);
    if (!pending) {
      pending = grammar(language).then(value => shiki.loadLanguage(value as Parameters<HighlighterCore["loadLanguage"]>[0]));
      grammarLoads.set(language, pending);
      pending.catch(() => grammarLoads.delete(language));
    }
    await pending;
  }
  let name = themes.get(theme);
  if (!name) {
    // A theme document per name and mode: BB changes the document when the palette or light/dark changes.
    // Named before the await, from a counter: two documents loading at once never share a name.
    name = "bb-" + theme.type + "-" + theme.name + "-" + ++themeCount;
    await shiki.loadTheme({...theme, name, tokenColors: [...theme.tokenColors]} as Parameters<HighlighterCore["loadTheme"]>[0]);
    themes.set(theme, name);
  }
  // A grammar compiles its patterns on its first line, which can take longer than the limit of a line: the first line of
  // the first diff would come plain. A short fixed line, tokenized once per language without a limit, takes that cost.
  if (!warmed.has(language)) {
    shiki.codeToTokensBase(WARM_UP, {lang: language, theme: name, tokenizeTimeLimit: 0});
    warmed.add(language);
  }
  const lines: ThemedToken[][] = shiki.codeToTokensBase(code, {lang: language, theme: name, tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: timeLimit});
  return lines.map(line => line.map(token => ({content: token.content, color: token.color, fontStyle: token.fontStyle})));
}
