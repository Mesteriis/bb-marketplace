import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { highlightPlan, languageOf, type RowPlace } from "../../core/highlight/plan.ts";
import type { LanguageId } from "../../core/highlight/plan.ts";
import type { CodeTheme, Token } from "./shiki.ts";

/**
 * What the app gives the highlighter: BB's current code theme (null until it resolves, and then nothing is painted)
 * and where a grammar comes from.
 */
export type Highlighting = {theme: CodeTheme | null; grammar(id: LanguageId): Promise<unknown>};
export const CodeThemeContext = createContext<Highlighting | null>(null);

/** Diffs with more rows than this stay plain: tokenizing them would hold the page up. */
export const MAX_HIGHLIGHT_ROWS = 5_000;
type Painted = {old: Token[][]; new: Token[][]; at: (RowPlace | null)[]};

/**
 * The tokens of each row of a shown diff, read after it renders plain. `enabled` is false for a folded file; a file
 * without a known language, a diff over MAX_HIGHLIGHT_ROWS or a failed load stays plain.
 */
export function useHighlight(path: string, rows: readonly {kind: string; text: string}[], enabled: boolean): (row: number, side?: "old" | "new") => Token[] | null {
  const highlighting = useContext(CodeThemeContext);
  const theme = highlighting?.theme ?? null;
  const language = languageOf(path);
  const [painted, setPainted] = useState<{rows: typeof rows; theme: CodeTheme; value: Painted} | null>(null);
  useEffect(() => {
    if (!enabled || !highlighting || !theme || !language || rows.length === 0 || rows.length > MAX_HIGHLIGHT_ROWS) return;
    if (painted && painted.rows === rows && painted.theme === theme) return;
    let live = true;
    const plan = highlightPlan(rows);
    import("./shiki.ts")
      .then(({tokenize}) => Promise.all([tokenize(plan.old, language, theme, highlighting.grammar), tokenize(plan.new, language, theme, highlighting.grammar)]))
      .then(([old, next]) => { if (live) setPainted({rows, theme, value: {old, new: next, at: plan.at}}); },
        () => {}); // Shiki, the grammar or the theme did not load: the diff stays as it is, plain.
    return () => { live = false; };
  }, [enabled, theme, language, rows]);
  // Tokens of another theme are not shown: a theme that failed to load leaves the diff plain, not in the old colours.
  const value = painted && painted.rows === rows && painted.theme === theme ? painted.value : null;
  return useMemo(() => (row, side) => {
    const place = value?.at[row];
    if (!value || !place) return null;
    const which = side ?? (place.new === null ? "old" : "new");
    const line = place[which];
    return line === null ? null : value[which][line] ?? null;
  }, [value]);
}

/**
 * Whether an element has come within a screen of the viewport (and stays true): a long page paints only the files
 * read, not all of them at once.
 */
export function useNear(element: { readonly current: Element | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (near || !target) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); } }, {rootMargin: "100% 0px"});
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

const styleOf = (token: Token) => ({color: token.color, fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
  fontWeight: token.fontStyle && token.fontStyle & 2 ? 600 : undefined, textDecoration: token.fontStyle && token.fontStyle & 4 ? "underline" : undefined});

/** A line's text, coloured when its tokens are known. */
export function CodeText({text, tokens}: {text: string; tokens: Token[] | null}): ReactNode {
  // Tokens that do not spell the line (a grammar that dropped or added text) are not trusted: the line shows as it is.
  if (!tokens || tokens.map(token => token.content).join("") !== text) return text;
  return tokens.map((token, index) => <span key={index} style={styleOf(token)}>{token.content}</span>);
}
