import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_MATCHES, type GoToItem } from "./navigation.ts";
import { useT } from "../i18n/use-t.tsx";

const shown = (count: number) => count >= MAX_MATCHES ? MAX_MATCHES + "+" : String(count);

/** Find in the diff: Enter goes to the next match, Shift+Enter to the previous one, Escape closes. */
export function FindBar({query, matchCase, count, current, onQuery, onMatchCase, onStep, onClose}: {
  query: string; matchCase: boolean; count: number; current: number;
  onQuery(value: string): void; onMatchCase(value: boolean): void; onStep(delta: 1 | -1): void; onClose(): void;
}) {
  const t = useT();
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };
  return <div className="git-code-review-find" role="search" aria-label={t("cr.find-in")}>
    <input className="g-inp" aria-label={t("cr.find")} autoFocus value={query} placeholder={t("cr.find-in")} onChange={event => onQuery(event.target.value)} onKeyDown={keys}/>
    <label><input type="checkbox" checked={matchCase} onChange={event => onMatchCase(event.target.checked)}/> {t("cr.match-case")}</label>
    <span className="g-muted" role="status">{!query ? "" : count === 0 ? t("cr.no-matches") : current < 0 ? t("cr.matches", {n: shown(count)}) : t("cr.match-of", {n: current + 1, all: shown(count)})}</span>
    <button type="button" className="g-btn ghost sm" disabled={!count} onClick={() => onStep(-1)} aria-label={t("cr.prev-match")}>↑</button>
    <button type="button" className="g-btn ghost sm" disabled={!count} onClick={() => onStep(1)} aria-label={t("cr.next-match")}>↓</button>
    <button type="button" className="g-btn ghost sm" onClick={onClose}>{t("ci.close")}</button>
  </div>;
}

/** Go to a file, a comment or a view: type to filter, ↑/↓ to choose, Enter to go, Escape to close. */
export function GoToDialog({items, onQuery, onPick, onClose}: {items: GoToItem[]; onQuery(value: string): void; onPick(item: GoToItem): void; onClose(): void}) {
  const t = useT();
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { setActive(0); }, [items]);
  useEffect(() => { list.current?.querySelector("[aria-selected=true]")?.scrollIntoView({block: "nearest"}); }, [active]);
  const label = useMemo(() => ({file: t("cr.go.file"), comment: t("cr.go.comment"), view: t("cr.go.view")}), [t]);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(items.length - 1, value + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
    if (event.key === "Enter" && items[active]) { event.preventDefault(); onPick(items[active]); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };
  return <div className="git-ci-threads git-code-review-goto" role="dialog" aria-label={t("cr.go-to")}>
    <input className="g-inp" aria-label={t("cr.go-label")} autoFocus placeholder={t("cr.go-hint")} role="combobox" aria-expanded="true" aria-controls="git-review-goto-list"
      aria-activedescendant={items[active] ? "git-review-goto-" + active : undefined} onChange={event => onQuery(event.target.value)} onKeyDown={keys}/>
    <ul id="git-review-goto-list" role="listbox" ref={list}>
      {items.map((item, index) => <li key={item.kind + item.label + index} id={"git-review-goto-" + index} role="option" aria-selected={index === active}
        onMouseEnter={() => setActive(index)} onClick={() => onPick(item)}>
        <span className="g-chip line">{label[item.kind]}</span> {item.label}</li>)}
      {!items.length && <li className="g-muted">{t("cr.nothing")}</li>}
    </ul>
    <div><button type="button" className="g-btn ghost sm" onClick={onClose}>{t("ci.close")}</button></div>
  </div>;
}
