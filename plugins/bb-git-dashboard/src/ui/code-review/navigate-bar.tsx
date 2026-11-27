import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_MATCHES, type GoToItem } from "./navigation.ts";

/** Find in the diff: Enter goes to the next match, Shift+Enter to the previous one, Escape closes. */
export function FindBar({query, matchCase, count, current, onQuery, onMatchCase, onStep, onClose}: {
  query: string; matchCase: boolean; count: number; current: number;
  onQuery(value: string): void; onMatchCase(value: boolean): void; onStep(delta: 1 | -1): void; onClose(): void;
}) {
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };
  return <div className="git-row git-code-review-find" role="search" aria-label="Find in the diff">
    <input aria-label="Find" autoFocus value={query} placeholder="Find in the diff" onChange={event => onQuery(event.target.value)} onKeyDown={keys}/>
    <label><input type="checkbox" checked={matchCase} onChange={event => onMatchCase(event.target.checked)}/> Match case</label>
    <span className="git-muted" role="status">{!query ? "" : count === 0 ? "No matches" : (current + 1) + " of " + (count >= MAX_MATCHES ? MAX_MATCHES + "+" : count)}</span>
    <button type="button" disabled={!count} onClick={() => onStep(-1)} aria-label="Previous match">↑</button>
    <button type="button" disabled={!count} onClick={() => onStep(1)} aria-label="Next match">↓</button>
    <button type="button" onClick={onClose}>Close</button>
  </div>;
}

/** Go to a file, a comment or a view: type to filter, ↑/↓ to choose, Enter to go, Escape to close. */
export function GoToDialog({items, onQuery, onPick, onClose}: {items: GoToItem[]; onQuery(value: string): void; onPick(item: GoToItem): void; onClose(): void}) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { setActive(0); }, [items]);
  useEffect(() => { list.current?.querySelector("[aria-selected=true]")?.scrollIntoView({block: "nearest"}); }, [active]);
  const label = useMemo(() => ({file: "File", comment: "Comment", view: "View"}), []);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(items.length - 1, value + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
    if (event.key === "Enter" && items[active]) { event.preventDefault(); onPick(items[active]); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };
  return <div className="git-ci-threads git-stack git-code-review-goto" role="dialog" aria-label="Go to">
    <input aria-label="Go to" autoFocus placeholder="File, comment or view" role="combobox" aria-expanded="true" aria-controls="git-review-goto-list"
      aria-activedescendant={items[active] ? "git-review-goto-" + active : undefined} onChange={event => onQuery(event.target.value)} onKeyDown={keys}/>
    <ul id="git-review-goto-list" role="listbox" ref={list}>
      {items.map((item, index) => <li key={item.kind + item.label + index} id={"git-review-goto-" + index} role="option" aria-selected={index === active}
        onMouseEnter={() => setActive(index)} onClick={() => onPick(item)}>
        <span className="git-review-tag">{label[item.kind]}</span> {item.label}</li>)}
      {!items.length && <li className="git-muted">Nothing matches.</li>}
    </ul>
    <div className="git-row"><button type="button" onClick={onClose}>Close</button></div>
  </div>;
}
