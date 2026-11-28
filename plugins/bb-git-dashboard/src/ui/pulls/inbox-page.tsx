import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { inboxTabs, type InboxTab } from "../../core/pulls/inbox.ts";
import { matchesSearch } from "../../core/pulls/model.ts";
import { en, type MessageKey } from "../../core/i18n/dictionary.ts";
import type { Language } from "../../core/i18n/language.ts";
import { ago } from "../../core/i18n/time.ts";
import { filterCounts, inboxFilters, matchesFilter, rowStates, type InboxFilter, type RowState } from "../../core/pulls/inbox-view.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import { forgeNames, grouped, severity, type AlertSummary, type InboxApi, type InboxItem, type InboxList } from "./inbox-api.ts";
import "./inbox.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
const remembered = (key: string): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]); } catch { return new Set(); }
};
const remember = (key: string, value: Set<string>) => { try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* not persisted */ } };
type T = ReturnType<typeof useT>;
const stateText = (t: T, state: RowState) => state.key === "note" ? state.text ?? "" : t(("in.s." + state.key) as MessageKey, state.n === undefined ? {} : {n: state.n});

// Survives the page's remount (opening a pull request and coming back): the tab, the search, the last lists, the row
// opened and where the list was scrolled, so the page comes back as it was left while a refresh runs.
const kept: {tab: InboxTab; query: string; filter: InboxFilter | null; lists: Partial<Record<InboxTab, {list: InboxList; at: number}>>; opened: string | null; scroll: number} =
  {tab: "open", query: "", filter: null, lists: {}, opened: null, scroll: 0};
/** The nearest ancestor that scrolls, where the page's position lives. */
const scrollerOf = (element: HTMLElement | null): HTMLElement | null => {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
};

/**
 * My PRs: every connected account's pull requests by tab, grouped by repository, each row with its states in words;
 * chips above the list count and filter what blocks them; new alerts in one line.
 */
export function InboxPage({api, alerts, onSeen, onOpen}: {api: InboxApi; alerts: AlertSummary | null; onSeen(): void;
  /** Opens a pull request inside Makosh Git, with the rows in page order for [ and ]. */
  onOpen?(item: InboxItem, order: InboxItem[]): void}) {
  const t = useT();
  const {language} = useLanguage();
  const [tab, setTabState] = useState<InboxTab>(kept.tab);
  // A chip filters the tab it was chosen on: another tab starts with every row.
  const setTab = (next: InboxTab) => { kept.tab = next; kept.scroll = 0; kept.filter = null; setFilterState(null); setTabState(next); };
  const [list, setList] = useState<InboxList | null>(() => kept.lists[kept.tab]?.list ?? null);
  const [counts, setCounts] = useState<InboxList["counts"]>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [filter, setFilterState] = useState<InboxFilter | null>(kept.filter);
  const [query, setQueryState] = useState(kept.query);
  const setQuery = (next: string) => { kept.query = next; setQueryState(next); };
  const [alertsOpen, setAlertsOpen] = useState(false);
  const setFilter = (next: InboxFilter | null) => { kept.filter = next; setFilterState(next); };
  const [folded, setFolded] = useState(() => remembered("makosh-git-inbox-folded"));
  const [hidden, setHidden] = useState(() => remembered("makosh-git-inbox-hidden/open"));
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLAnchorElement | null)[]>([]);

  // When the list was last read, and a clock for "updated N ago".
  const [readAt, setReadAt] = useState<number | null>(() => kept.lists[kept.tab]?.at ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  // Merged and Closed keep only their newest rows; a search there reads the whole history once per tab.
  // A failed read is kept for its tab: the search falls back to the loaded rows rather than asking again and again.
  const [history, setHistory] = useState<{tab: InboxTab; groups: InboxList["groups"] | null} | "loading" | null>(null);
  const searchesHistory = (tab === "merged" || tab === "closed") && query.trim() !== "";
  useEffect(() => {
    if (!searchesHistory || (history !== null && (history === "loading" || history.tab === tab))) return;
    const asked = tab as "merged" | "closed";
    setHistory("loading");
    api.history(asked).then(result => setHistory({tab: asked, groups: result.groups}), () => setHistory({tab: asked, groups: null}));
  }, [searchesHistory, tab, history, api]);
  const latest = useRef(0);
  const load = useCallback(async (next: InboxTab) => {
    // Only the latest request may fill the page: a slower answer for a tab left behind is dropped.
    const request = ++latest.current;
    setPending(true); setError("");
    try {
      const result = await api.list(next);
      if (request !== latest.current) return;
      setList(result);
      const at = Date.now();
      kept.lists[next] = {list: result, at};
      setReadAt(at);
      setCounts(previous => ({...previous, ...result.counts}));
    } catch (failure) { if (request === latest.current) setError(message(failure)); }
    finally { if (request === latest.current) setPending(false); }
  }, [api]);
  useEffect(() => {
    // A tab read before shows at once; the refresh replaces it when it answers.
    setList(kept.lists[tab]?.list ?? null); setReadAt(kept.lists[tab]?.at ?? null);
    setCursor(0); setHistory(null); setHidden(remembered("makosh-git-inbox-hidden/" + tab)); void load(tab);
  }, [tab, load]);
  // Coming back: the scroll position, and the row last opened focused, so j / k and Enter carry on from it.
  const page = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !list) return;
    restored.current = true;
    const scroller = scrollerOf(page.current);
    if (scroller) scroller.scrollTop = kept.scroll;
    const row = kept.opened ? page.current?.querySelector<HTMLElement>("[data-pr-row=\"" + CSS.escape(kept.opened) + "\"]") : null;
    row?.focus({preventScroll: true});
    kept.opened = null;
  }, [list]);
  useEffect(() => {
    const scroller = scrollerOf(page.current);
    if (!scroller) return;
    const save = () => { kept.scroll = scroller.scrollTop; };
    scroller.addEventListener("scroll", save, {passive: true});
    return () => scroller.removeEventListener("scroll", save);
  }, [list !== null]);

  const whole = searchesHistory && history !== null && history !== "loading" && history.tab === tab && history.groups ? {groups: history.groups} : null;
  const source = useMemo(() => list ? (whole ? {...list, groups: whole.groups} : list) : null, [list, whole]);
  // Rows by repository across accounts (an account's name stays in the group's tooltip); the chips count what the tab shows.
  const visible = useMemo(() => source ? grouped(source, item => matchesSearch(item, query), hidden) : [], [source, query, hidden]);
  const chips = useMemo(() => filterCounts(visible.flatMap(group => group.repos.flatMap(repo => repo.items))), [visible]);
  const repos = visible.flatMap(group => group.repos.map(repo => ({...repo, account: group.account,
    items: repo.items.filter(item => matchesFilter(item, filter))}))).filter(repo => repo.items.length);
  const allKeys = repos.map(repo => repo.key);
  const flat = repos.flatMap(repo => folded.has(repo.key) ? [] : repo.items);
  const hiddenCount = hidden.size;
  const terminal = tab === "merged" || tab === "closed";

  function toggle(set: Set<string>, key: string, store: string, apply: (value: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    remember(store, next); apply(next);
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === "/") { event.preventDefault(); search.current?.focus(); return; }
    if (event.key !== "j" && event.key !== "k") return;
    event.preventDefault();
    const next = Math.max(0, Math.min(flat.length - 1, cursor + (event.key === "j" ? 1 : -1)));
    setCursor(next);
    rows.current[next]?.focus();
  }
  let index = -1;
  const unseen = alerts?.alerts.filter(alert => !alert.seen) ?? [];

  return <div ref={page} className="g-page git-inbox" onKeyDown={keys} role="region" aria-label={t("in.region")}>
    <PageHead title={t("section.inbox")} sub={list ? t("in.sub", {accounts: list.groups.length, when: readAt === null ? "" : ago(language, now, new Date(readAt).toISOString())}) : undefined}
      actions={<>
        <input ref={search} className="g-inp" type="search" aria-label={t("in.search-label")} placeholder={t("in.search")} value={query} onChange={event => setQuery(event.target.value)}/>
        {api.SettingsLink && <api.SettingsLink><Icon name="BellDot" small/><span className="g-sr">{t("in.alerts")}</span></api.SettingsLink>}
        <button type="button" className="g-btn" disabled={pending} onClick={() => void load(tab)}><Icon name="RotateCcw" small/>{t("ov.refresh")}</button>
      </>}/>
    <div className="g-views git-inbox-views">
      <div role="tablist" aria-label={t("in.tabs")} className="git-inbox-tabs">
        {inboxTabs.map(name => <button key={name} id={"git-inbox-" + name} type="button" role="tab" aria-selected={name === tab} aria-controls="git-inbox-panel"
          tabIndex={name === tab ? 0 : -1} data-tab={name} onClick={() => setTab(name)} onKeyDown={event => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next = event.key === "Home" ? inboxTabs[0]! : event.key === "End" ? inboxTabs[inboxTabs.length - 1]!
              : step ? inboxTabs[(inboxTabs.indexOf(name) + step + inboxTabs.length) % inboxTabs.length]! : null;
            if (!next) return;
            event.preventDefault();
            event.stopPropagation();
            setTab(next);
            (event.currentTarget.parentElement?.querySelector("[data-tab=\"" + next + "\"]") as HTMLElement | null)?.focus();
          }}>{t(("in.tab." + name) as MessageKey)}{counts[name] !== undefined && <span className="g-num g-muted">{counts[name]}</span>}</button>)}
      </div>
      <span className="g-muted git-inbox-keys"><kbd className="g-kbd">j</kbd> <kbd className="g-kbd">k</kbd> {t("in.keys")} · <kbd className="g-kbd">/</kbd> {t("in.keys-search")}</span>
    </div>
    <div role="tabpanel" id="git-inbox-panel" aria-labelledby={"git-inbox-" + tab} className="git-inbox-body">
      {unseen.length > 0 && <section className="g-banner git-inbox-new" aria-label={t("in.new")}>
        <Icon name="BellDot" small/><strong>{t("in.new")}</strong>
        <span className="git-inbox-new-first g-bad">{unseen[0]!.url ? <a href={unseen[0]!.url} target="_blank" rel="noreferrer">{unseen[0]!.headline}</a> : unseen[0]!.headline}
          {unseen[0]!.detail ? " · " + unseen[0]!.detail : ""}</span>
        {unseen.length > 1 && <button type="button" className="g-btn ghost sm" aria-expanded={alertsOpen} onClick={() => setAlertsOpen(value => !value)}>{t("in.new-more", {n: unseen.length - 1})}</button>}
        <button type="button" className="g-btn sm" onClick={onSeen}>{t("in.seen")}</button>
        {alertsOpen && <ul className="git-inbox-new-list">{unseen.slice(1, 10).map(alert => <li key={alert.id}>
          {alert.url ? <a href={alert.url} target="_blank" rel="noreferrer">{alert.headline}</a> : <strong>{alert.headline}</strong>} <span className="g-muted">{alert.detail}</span></li>)}</ul>}
      </section>}
      {!terminal && list && <div className="git-inbox-filters" role="group" aria-label={t("in.filters")}>
        <span className="g-muted">{t("in.filters")}:</span>
        {inboxFilters.map(name => <button key={name} type="button" className={"g-chip " + (chips[name] ? filterTones[name] : "line")} aria-pressed={filter === name}
          onClick={() => setFilter(filter === name ? null : name)}>{t(("in.f." + name) as MessageKey)} <span className="g-num">{chips[name]}</span></button>)}
        {repos.length > 0 && <button type="button" className="g-btn ghost sm git-inbox-fold" onClick={() => {
          const all = allKeys.every(key => folded.has(key));
          const next = all ? new Set([...folded].filter(key => !allKeys.includes(key))) : new Set([...folded, ...allKeys]);
          remember("makosh-git-inbox-folded", next); setFolded(next);
        }}>{allKeys.every(key => folded.has(key)) ? t("in.expand") : t("in.collapse")}</button>}
      </div>}
      {searchesHistory && (history === "loading" ? <p className="g-muted git-inbox-note" role="status">{t("in.history-loading")}</p>
        : whole && <p className="g-muted git-inbox-note">{t("in.history", {n: whole.groups.reduce((sum, group) => sum + group.items.length, 0)})}</p>)}
      {error && <div className="g-banner bad" role="alert">{error}</div>}
      {visible.filter(group => group.error || group.notice).map(group => <div key={group.account.id} className={"g-banner" + (group.error ? " bad" : "")} role={group.error ? "alert" : "status"}>
        <strong>{group.account.label}</strong> {group.error ?? group.notice}</div>)}
      {!query && visible.map(group => { const shown = group.items.length, total = group.total;
        return total !== null && shown < total ? <p key={group.account.id} className="g-muted git-inbox-note">{group.account.label}: {t("in.showing", {shown, total})}{terminal ? " " + t("in.showing-search") : ""}</p> : null; })}
      {pending && !list && <p className="g-state-page" role="status">{t("in.loading")}</p>}
      {hiddenCount > 0 && <p className="g-muted git-inbox-note">{t("in.hidden", {n: hiddenCount})} ·{" "}
        <button type="button" className="g-btn ghost sm" onClick={() => { remember("makosh-git-inbox-hidden/" + tab, new Set()); setHidden(new Set()); }}>{t("in.show-all")}</button></p>}
      {list && !list.groups.length && <div className="g-state-page" role="status"><strong>{t("in.no-accounts")}</strong></div>}
      {list && list.groups.length > 0 && !repos.length && !error && <div className="g-state-page" role="status">{query ? t("in.no-match") : t("in.nothing")}</div>}
      {repos.map(repo => {
        const open = !folded.has(repo.key);
        const name = repo.repo + " · " + forgeNames[repo.account.kind];
        const twice = repos.some(other => other !== repo && other.repo === repo.repo && other.account.kind === repo.account.kind);
        return <section key={repo.key} className="git-inbox-repo" aria-label={twice ? name + " · " + repo.account.label : name}>
          <div className="git-inbox-repo-head">
            <button type="button" className="git-inbox-group" aria-expanded={open} aria-label={t(open ? "in.hide-group" : "in.show", {name})} title={repo.account.label}
              onClick={() => toggle(folded, repo.key, "makosh-git-inbox-folded", setFolded)}>
              <Icon name={open ? "ChevronDown" : "ChevronRight"} small/><span>{name}</span> <span className="g-num g-muted">{repo.items.length}</span></button>
            <button type="button" className="g-btn ghost sm git-inbox-hide" onClick={() => toggle(hidden, repo.key, "makosh-git-inbox-hidden/" + tab, setHidden)}>{t("in.hide")}</button>
          </div>
          {open && <ul className="git-inbox-list">{repo.items.map(item => {
            index += 1;
            const position = index;
            return <Row key={item.id} item={item} tab={tab} t={t} language={language} now={now} current={position === cursor}
              onOpen={onOpen && (() => { kept.opened = item.id; onOpen(item, flat); })}
              bind={element => { rows.current[position] = element; }} onFocus={() => setCursor(position)}/>;
          })}</ul>}
        </section>;
      })}
    </div>
  </div>;
}
const filterTones: Record<InboxFilter, string> = {"ci-failed": "bad", conflict: "warn", changes: "warn", unanswered: "line", ready: "good"};

function Row({item, tab, t, language, now, current, bind, onFocus, onOpen}: {item: InboxItem; tab: InboxTab; t: T; language: Language; now: number; current: boolean;
  bind(element: HTMLAnchorElement | null): void; onFocus(): void; onOpen?(): void}) {
  const stale = tab === "reviewed" && item.myReview?.stale;
  const states = rowStates(item);
  return <li className="git-inbox-item" data-severity={severity(item)} data-current={current || undefined}>
    <a ref={bind} href={item.url} target="_blank" rel="noreferrer" data-pr-row={item.id} onFocus={onFocus} onClick={event => {
      // A plain click or Enter opens the pull request here; a modified click still opens the forge.
      if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onOpen();
    }}>
      <span className="git-inbox-title">{item.title}</span>
      <span className="g-muted git-inbox-meta">#{item.number} · {item.author}{item.additions !== null && item.deletions !== null &&
        <> · <span className="g-good">+{item.additions}</span> <span className="g-bad">−{item.deletions}</span></>} · {t("in.meta-updated", {when: ago(language, now, item.updatedAt)})}</span>
    </a>
    <div className="git-inbox-badges">
      {states.map((state, index) => <span key={state.key + index} className={"g-chip git-inbox-blocker " + state.tone}>{stateText(t, state)}</span>)}
      {tab === "reviewed" && item.myReview && <span className={"g-chip git-inbox-blocker " + (stale ? "warn" : "line")} data-stale={stale || undefined}>
        {stale ? t("in.reviewed-stale") : ("in.rv." + item.myReview.state) in en ? t(("in.rv." + item.myReview.state) as MessageKey) : item.myReview.state}</span>}
      {item.mergedAt && <span className="g-muted">{t("in.merged-at", {when: ago(language, now, item.mergedAt)})}</span>}
      {item.closedAt && <span className="g-muted">{t("in.closed-at", {when: ago(language, now, item.closedAt)})}</span>}
      <Icon name="ChevronRight" small/>
    </div>
  </li>;
}

/** Alerts that arrived while BB is open, shown for a few seconds; Open goes to the pull request in Makosh Git. */
export function InboxToasts({alerts, onOpen}: {alerts: AlertSummary | null; onOpen(alert: AlertSummary["alerts"][number]): void}) {
  const [shown, setShown] = useState<AlertSummary["alerts"]>([]);
  const known = useRef<Set<string> | null>(null);
  // Alerts made after the toasts mounted are new even when the first summary read arrives late (its first try failed).
  const mounted = useRef(new Date().toISOString());
  // Each toast owns its timer, so a later update of the alert list cannot keep one on screen.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setShown(previous => previous.filter(alert => alert.id !== id));
  }, []);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  useEffect(() => {
    if (!alerts) return;
    const ids = new Set(alerts.alerts.map(alert => alert.id));
    const first = known.current === null;
    const fresh = alerts.toasts ? alerts.alerts.filter(alert => !alert.seen && (first ? alert.at > mounted.current : !known.current!.has(alert.id))) : [];
    known.current = ids;
    for (const alert of fresh) timers.current.set(alert.id, setTimeout(() => dismiss(alert.id), 8000));
    if (fresh.length) setShown(previous => [...fresh, ...previous].slice(0, 3));
  }, [alerts, dismiss]);
  if (!shown.length) return null;
  return <div className="git-inbox-toasts" role="status" aria-live="polite">
    {shown.map(alert => <div key={alert.id} className="git-inbox-toast">
      <div className="git-inbox-toast-text"><strong>{alert.headline}</strong><span>{alert.detail}</span></div>
      <div className="git-row">
        <button type="button" onClick={() => { dismiss(alert.id); onOpen(alert); }}>Open</button>
        <button type="button" className="git-link" aria-label="Close" onClick={() => dismiss(alert.id)}>×</button>
      </div>
    </div>)}
  </div>;
}
