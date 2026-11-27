import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { inboxTabs, type InboxTab } from "../../core/pulls/inbox.ts";
import { matchesSearch } from "../../core/pulls/model.ts";
import { forgeNames, grouped, severity, tabLabels, type AlertSummary, type InboxApi, type InboxItem, type InboxList } from "./inbox-api.ts";
import "./inbox.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
const remembered = (key: string): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]); } catch { return new Set(); }
};
const remember = (key: string, value: Set<string>) => { try { localStorage.setItem(key, JSON.stringify([...value])); } catch { /* not persisted */ } };
const reviewText: Record<string, string> = {APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented",
  DISMISSED: "Dismissed", APPROVED_WITH_SUGGESTIONS: "Approved with suggestions", WAITING_FOR_AUTHOR: "Waiting for author", REJECTED: "Rejected"};

/** My PRs: every connected account's pull requests by tab, what blocks each one, and new alerts. */
export function InboxPage({api, alerts, onSeen, onOpen}: {api: InboxApi; alerts: AlertSummary | null; onSeen(): void;
  /** Opens a pull request inside Makosh Git, with the rows in page order for [ and ]. */
  onOpen?(item: InboxItem, order: InboxItem[]): void}) {
  const [tab, setTab] = useState<InboxTab>("open");
  const [list, setList] = useState<InboxList | null>(null);
  const [counts, setCounts] = useState<InboxList["counts"]>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState(() => remembered("makosh-git-inbox-folded"));
  const [hidden, setHidden] = useState(() => remembered("makosh-git-inbox-hidden/open"));
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLAnchorElement | null)[]>([]);

  const latest = useRef(0);
  const load = useCallback(async (next: InboxTab) => {
    // Only the latest request may fill the page: a slower answer for a tab left behind is dropped.
    const request = ++latest.current;
    setPending(true); setError("");
    try {
      const result = await api.list(next);
      if (request !== latest.current) return;
      setList(result);
      setCounts(previous => ({...previous, ...result.counts}));
    } catch (failure) { if (request === latest.current) setError(message(failure)); }
    finally { if (request === latest.current) setPending(false); }
  }, [api]);
  useEffect(() => { setList(null); setCursor(0); setHidden(remembered("makosh-git-inbox-hidden/" + tab)); void load(tab); }, [tab, load]);

  const groups = useMemo(() => list ? grouped(list, item => matchesSearch(item, query), hidden) : [], [list, query, hidden]);
  const flat = groups.flatMap(group => group.repos.flatMap(repo => folded.has(repo.key) ? [] : repo.items));
  const hiddenCount = hidden.size;

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

  return <section className="git-inbox" onKeyDown={keys} aria-label="My pull requests">
    <div className="git-row git-inbox-toolbar">
      <h2>My PRs</h2>
      <input ref={search} type="search" aria-label="Search pull requests" placeholder="Title, #number, repository, author or blocker  ( / )"
        value={query} onChange={event => setQuery(event.target.value)}/>
      <button type="button" disabled={pending} onClick={() => void load(tab)}>Refresh</button>
    </div>
    <nav className="git-inbox-tabs" aria-label="Pull request tabs">
      {inboxTabs.map(name => <button key={name} type="button" aria-current={name === tab ? "page" : undefined} onClick={() => setTab(name)}>
        {tabLabels[name]}{counts[name] !== undefined && <span className="git-inbox-count">{counts[name]}</span>}
      </button>)}
    </nav>
    {alerts && alerts.unseen > 0 && <section className="git-inbox-new" aria-label="New since you last looked">
      <div className="git-row"><strong>New since you last looked</strong><button type="button" onClick={onSeen}>Mark as seen</button></div>
      <ul>{alerts.alerts.filter(alert => !alert.seen).slice(0, 10).map(alert => <li key={alert.id}>
        <a href={alert.url} target="_blank" rel="noreferrer">{alert.headline}</a> <span className="git-muted">{alert.detail}</span>
      </li>)}</ul>
    </section>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {pending && !list && <p className="git-muted" role="status">Loading pull requests…</p>}
    {hiddenCount > 0 && <p className="git-muted">{hiddenCount} hidden {hiddenCount === 1 ? "repository" : "repositories"} on this tab ·{" "}
      <button type="button" className="git-link" onClick={() => { remember("makosh-git-inbox-hidden/" + tab, new Set()); setHidden(new Set()); }}>Show all</button></p>}
    {list && !list.groups.length && <p className="git-muted">No connected accounts. Add one in Подключения.</p>}
    {groups.map(group => <section key={group.account.id} className="git-inbox-account" aria-label={group.account.label}>
      <h3>{group.account.label} <span className="git-muted">{forgeNames[group.account.kind]}</span></h3>
      {group.error && <p className="git-error" role="alert">{group.error}</p>}
      {group.notice && <p className="git-muted" role="status">{group.notice}</p>}
      {!group.error && !group.repos.length && <p className="git-muted">{query ? "Nothing matches the search." : "Nothing here."}</p>}
      {group.repos.map(repo => <div key={repo.key} className="git-inbox-repo">
        <div className="git-row git-inbox-repo-head">
          <button type="button" className="git-link" aria-expanded={!folded.has(repo.key)}
            onClick={() => toggle(folded, repo.key, "makosh-git-inbox-folded", setFolded)}>{folded.has(repo.key) ? "▸" : "▾"} {repo.repo}</button>
          <span className="git-muted">{repo.items.length}</span>
          <button type="button" className="git-link git-inbox-hide" onClick={() =>
            toggle(hidden, repo.key, "makosh-git-inbox-hidden/" + tab, setHidden)}>Hide</button>
        </div>
        {!folded.has(repo.key) && <ul className="git-inbox-list">{repo.items.map(item => {
          index += 1;
          const position = index;
          return <Row key={item.id} item={item} tab={tab} current={position === cursor} onOpen={onOpen && (() => onOpen(item, flat))}
            bind={element => { rows.current[position] = element; }} onFocus={() => setCursor(position)}/>;
        })}</ul>}
      </div>)}
    </section>)}
  </section>;
}

function Row({item, tab, current, bind, onFocus, onOpen}: {item: InboxItem; tab: InboxTab; current: boolean; bind(element: HTMLAnchorElement | null): void;
  onFocus(): void; onOpen?(): void}) {
  const stale = tab === "reviewed" && item.myReview?.stale;
  return <li className="git-inbox-item" data-severity={severity(item)} data-current={current || undefined}>
    <a ref={bind} href={item.url} target="_blank" rel="noreferrer" onFocus={onFocus} onClick={event => {
      // A plain click or Enter opens the pull request here; a modified click still opens the forge.
      if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onOpen();
    }}>
      <span className="git-inbox-title">{item.title}</span>
      <span className="git-muted">#{item.number} · {item.author}{item.additions !== null && item.deletions !== null &&
        <> · <span className="git-inbox-plus">+{item.additions}</span> <span className="git-inbox-minus">−{item.deletions}</span></>}</span>
    </a>
    <div className="git-inbox-badges">
      {item.blockers.map(blocker => <span key={blocker} className="git-inbox-blocker">{blocker}</span>)}
      {tab === "reviewed" && item.myReview && <span className="git-inbox-blocker" data-stale={stale || undefined}>
        {stale ? "Updated after your review" : reviewText[item.myReview.state] ?? item.myReview.state}</span>}
      {item.mergedAt && <span className="git-muted">Merged {item.mergedAt.slice(0, 10)}</span>}
      {item.closedAt && <span className="git-muted">Closed {item.closedAt.slice(0, 10)}</span>}
      {onOpen && <a className="git-muted" href={item.url} target="_blank" rel="noreferrer" aria-label={"Open #" + item.number + " on the forge"}>↗</a>}
    </div>
  </li>;
}

/** Alerts that arrived while the page is open, shown for a few seconds. */
export function InboxToasts({alerts}: {alerts: AlertSummary | null}) {
  const [shown, setShown] = useState<AlertSummary["alerts"]>([]);
  const known = useRef<Set<string> | null>(null);
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
    if (known.current === null) { known.current = ids; return; }
    const fresh = alerts.toasts ? alerts.alerts.filter(alert => !known.current!.has(alert.id) && !alert.seen) : [];
    known.current = ids;
    for (const alert of fresh) timers.current.set(alert.id, setTimeout(() => dismiss(alert.id), 8000));
    if (fresh.length) setShown(previous => [...fresh, ...previous].slice(0, 3));
  }, [alerts, dismiss]);
  if (!shown.length) return null;
  return <div className="git-inbox-toasts" role="status" aria-live="polite">
    {shown.map(alert => <div key={alert.id} className="git-inbox-toast">
      <a href={alert.url} target="_blank" rel="noreferrer"><strong>{alert.headline}</strong><span>{alert.detail}</span></a>
      <button type="button" className="git-link" aria-label="Close" onClick={() => dismiss(alert.id)}>×</button>
    </div>)}
  </div>;
}
