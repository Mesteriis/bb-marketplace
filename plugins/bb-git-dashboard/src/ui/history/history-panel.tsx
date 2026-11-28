import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { layoutCommitGraph } from "../../core/history/graph.ts";
import { conventionalPrefix, matchesCommit, reachableFromHead, visibleRefs } from "../../core/history/view.ts";
import type { CommitSummary, HistoryPage } from "../../core/history/model.ts";
import { ago } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { ChangeView } from "./commit-view.tsx";
import { GraphCell, WorkingCell, graphWidth } from "./graph-cell.tsx";
import { message, type HistoryApi } from "./history-api.ts";
import "./history.css";

const watchEvery = 10_000;
const maxGraph = 220;
const maxRefs = 3;
/** The search and the branch choice of each copy's History, kept in this browser tab while the tab is left. */
const kept = new Map<string, {query: string; current: boolean}>();
function keptOf(copyId: string): {query: string; current: boolean} {
  const own = kept.get(copyId);
  if (own) return own;
  try {
    const saved = JSON.parse(sessionStorage.getItem("git-history/" + copyId) ?? "null") as {query?: unknown; current?: unknown} | null;
    if (saved && typeof saved.query === "string" && typeof saved.current === "boolean") return {query: saved.query, current: saved.current};
  } catch { /* nothing kept */ }
  return {query: "", current: false};
}
function keep(copyId: string, value: {query: string; current: boolean}) {
  kept.set(copyId, value);
  try { sessionStorage.setItem("git-history/" + copyId, JSON.stringify(value)); } catch { /* kept in memory only */ }
}
/** Appends commits not already listed; a page may overlap the previous one when refs moved in between. */
const unique = (current: CommitSummary[], next: CommitSummary[]) => {
  const known = new Set(current.map(commit => commit.hash));
  return [...current, ...next.filter(commit => !known.has(commit.hash))];
};

/**
 * The graph of all refs (or of HEAD's history only) with the working tree's changes on top, a search in the loaded
 * commits, and beside it the chosen commit: its facts, files and the chosen file's diff.
 */
export function HistoryPanel({api, copyId, graph = true}: {api: HistoryApi; copyId: string; graph?: boolean}) {
  const t = useT();
  const {language} = useLanguage();
  const [page, setPage] = useState<HistoryPage>();
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState(() => keptOf(copyId).query);
  const [current, setCurrent] = useState(() => keptOf(copyId).current);
  useEffect(() => keep(copyId, {query, current}), [copyId, query, current]);
  const [refreshing, setRefreshing] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const commitsRef = useRef<CommitSummary[]>([]);
  const reloadSoon = () => setReload(value => value + 1);
  // A refresh reloads as many commits as were shown, so older pages and the selection survive it.
  useEffect(() => {
    let active = true;
    const shown = Math.max(1, commitsRef.current.length);
    (async () => {
      const first = await api.page(copyId, 0);
      let loaded = first.commits;
      let more = first.more;
      while (more && loaded.length < shown && loaded.length < 1000) {
        const next = await api.page(copyId, loaded.length);
        if (next.revision !== first.revision) { if (active) reloadSoon(); return; }
        loaded = unique(loaded, next.commits);
        more = next.more;
      }
      if (!active) return;
      setPage({...first, more}); setCommits(loaded); setError(""); setRefreshing(false);
      setSelected(chosen => chosen ?? (first.uncommitted.length ? "working" : first.commits[0]?.hash ?? null));
    })().catch(cause => { if (active) { setError(message(cause)); setRefreshing(false); } });
    return () => { active = false; };
  }, [api, copyId, reload]);
  useEffect(() => { commitsRef.current = commits; }, [commits]);
  // One revision check at a time, and none while the tab is hidden.
  useEffect(() => {
    if (!page) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!document.hidden) {
        const revision = await api.revision(copyId).catch(() => page.revision);
        if (!active) return;
        if (revision !== page.revision) { setReload(value => value + 1); return; }
      }
      if (active) timer = setTimeout(check, watchEvery);
    };
    timer = setTimeout(check, watchEvery);
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, page]);
  const shown = useMemo(() => current ? reachableFromHead(commits) : commits, [commits, current]);
  const rows = useMemo(() => layoutCommitGraph(shown), [shown]);
  const full = graph ? graphWidth(Math.max(1, ...rows.map(row => row.laneCount))) : 0;
  const width = Math.min(full, maxGraph);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => searching ? shown.flatMap((commit, index) => matchesCommit(commit, query) ? [index] : []) : [], [shown, query, searching]);
  const matched = useMemo(() => new Set(matches), [matches]);
  /** Enter selects the next match and Shift+Enter the previous one, scrolling it into view. */
  const step = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setQuery(""); return; }
    if (event.key !== "Enter" || !matches.length) return;
    event.preventDefault();
    const at = shown.findIndex(commit => commit.hash === selected);
    const next = event.shiftKey ? [...matches].reverse().find(index => index < at) ?? matches[matches.length - 1]!
      : matches.find(index => index > at) ?? matches[0]!;
    setSelected(shown[next]!.hash);
    list.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({block: "nearest"});
  };
  const more = async () => {
    if (!page) return;
    setLoading(true);
    try {
      const next = await api.page(copyId, commits.length);
      // Refs moved since the first page: the offset no longer lines up, so reload the whole list instead.
      if (next.revision !== page.revision) { reloadSoon(); return; }
      setCommits(list => unique(list, next.commits));
      setPage(value => value && {...value, more: next.more});
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const when = (at: string) => ago(language, Date.now(), at);
  // The working tree sits over HEAD's lane; HEAD is the commit holding the checked-out branch, not always the first row.
  const headIndex = shown.findIndex(commit => commit.refs.some(ref => ref.isHead));
  const headLane = rows[headIndex >= 0 ? headIndex : 0]?.commitLane ?? 0;
  const headLoaded = commits.some(commit => commit.refs.some(ref => ref.isHead));
  return <section className="git-history-panel" aria-label={t("pg.tab.history")}>
    <div className="git-history-bar">
      <label className="git-ci-log-find git-history-find"><Icon name="Search" small/>
        <input type="search" aria-label={t("hs.find")} placeholder={t("hs.find")} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={step}/></label>
      <div className="g-seg" role="group" aria-label={t("hs.which")}>
        <button type="button" aria-pressed={!current} onClick={() => setCurrent(false)}>{t("hs.all")}</button>
        <button type="button" aria-pressed={current} onClick={() => setCurrent(true)}>{t("hs.current")}</button>
      </div>
      {page && <span className="g-muted">{t("hs.total", {n: page.total})} · {page.currentBranch ? t("hs.on", {branch: page.currentBranch}) : t("hs.detached")}</span>}
      {searching && <span className="g-muted" role="status">{t(page?.more ? "hs.matches-loaded" : "hs.matches", {n: matches.length})}</span>}
      <button type="button" className="g-btn ghost git-ci-end" disabled={refreshing} onClick={() => { setRefreshing(true); reloadSoon(); }}>
        <Icon name="RotateCcw" small/>{refreshing ? t("hs.refreshing") : t("ci.refresh")}</button>
    </div>
    {page && current && !headLoaded && <p className="git-ci-status g-muted git-history-warn" role="status">{t("hs.head-missing")}</p>}
    {!page && (error ? <div className="g-banner bad" role="alert">{error}</div> : <p className="g-state-page" role="status">{t("hs.loading")}</p>)}
    {page && <div className="git-history">
      <section className="git-history-list" aria-label={t("hs.list")}>
        <ol className="git-history-rows" ref={list} data-searching={searching || undefined}>
          {page.uncommitted.length > 0 && <li><button type="button" className="git-history-row" aria-current={selected === "working" ? "true" : undefined}
            onClick={() => setSelected("working")}>
            {graph ? <span className="git-history-graph-clip" style={{width}}><WorkingCell lane={headLane} width={full}/></span> : null}
            <span className="git-history-text"><span className="git-history-subject">{t("hs.uncommitted")} · {t("hs.files", {n: page.uncommitted.length})}</span></span>
            <span className="g-muted git-history-meta">{t("hs.now")}</span></button></li>}
          {shown.map((commit, index) => {
            const {shown: refs, hidden} = visibleRefs(commit.refs, maxRefs);
            const conventional = conventionalPrefix(commit.subject);
            return <li key={commit.hash} data-index={index} data-match={searching ? matched.has(index) || undefined : undefined}>
              <button type="button" className="git-history-row" aria-current={selected === commit.hash ? "true" : undefined} onClick={() => setSelected(commit.hash)}>
                {graph && <span className="git-history-graph-clip" style={{width}}><GraphCell row={rows[index]!} width={full} head={commit.refs.some(ref => ref.isHead)}/></span>}
                <span className="git-history-text">
                  {refs.length > 0 && <span className="git-history-refs">{refs.map(ref =>
                    <span key={ref.fullName} className="git-history-ref" data-kind={ref.kind} data-head={ref.isHead || undefined}>{ref.name}</span>)}
                    {hidden.length > 0 && <span className="git-history-ref git-history-more" title={hidden.map(ref => ref.name).join("\n")}
                      aria-label={t("hs.more-refs", {n: hidden.length, names: hidden.map(ref => ref.name).join(", ")})}>+{hidden.length}</span>}</span>}
                  <span className="git-history-subject">{conventional
                    ? <><span className="git-history-type">{conventional.prefix}</span>{conventional.rest}</> : commit.subject}</span>
                </span>
                <span className="g-muted git-history-meta">{commit.authorName} · <time dateTime={commit.authorDate}
                  title={commit.authorDate.replace("T", " ").slice(0, 16)}>{when(commit.authorDate)}</time></span>
              </button></li>;
          })}
        </ol>
        {!commits.length && !page.uncommitted.length && <p className="g-state-page">{t("hs.none")}</p>}
        {page.more && <button type="button" className="git-history-older" disabled={loading} onClick={() => void more()}>
          {loading ? t("common.loading") : t("hs.older")}</button>}
        {error && <div className="g-banner bad" role="alert">{error}</div>}
      </section>
      {selected && <ChangeView key={selected} api={api} copyId={copyId} hash={selected === "working" ? null : selected} uncommitted={page.uncommitted}/>}
    </div>}
  </section>;
}
