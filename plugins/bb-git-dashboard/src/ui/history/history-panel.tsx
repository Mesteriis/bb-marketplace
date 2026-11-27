import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { layoutCommitGraph } from "../../core/history/graph.ts";
import { conventionalPrefix, dayGroups, matchesCommit, visibleRefs } from "../../core/history/view.ts";
import type { CommitSummary, HistoryPage } from "../../core/history/model.ts";
import { ChangeView } from "./commit-view.tsx";
import { GraphCell, LanesThrough, graphWidth } from "./graph-cell.tsx";
import { message, type HistoryApi } from "./history-api.ts";
import "./history.css";

const watchEvery = 10_000;
const when = (value: string) => value.replace("T", " ").slice(0, 16);
const maxGraph = 220;
const maxRefs = 3;
const headingHeight = 24;
/** Appends commits not already listed; a page may overlap the previous one when refs moved in between. */
const unique = (current: CommitSummary[], next: CommitSummary[]) => {
  const known = new Set(current.map(commit => commit.hash));
  return [...current, ...next.filter(commit => !known.has(commit.hash))];
};

/** The graph of all refs with the working tree's changes on top; a selected commit opens its files and patches. */
export function HistoryPanel({api, copyId, graph = true}: {api: HistoryApi; copyId: string; graph?: boolean}) {
  const [page, setPage] = useState<HistoryPage>();
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
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
      setSelected(current => current ?? (first.uncommitted.length ? "working" : first.commits[0]?.hash ?? null));
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
  const rows = useMemo(() => layoutCommitGraph(commits), [commits]);
  const full = graph ? graphWidth(Math.max(1, ...rows.map(row => row.laneCount))) : 0;
  const width = Math.min(full, maxGraph);
  const days = useMemo(() => new Map(dayGroups(commits, Date.now(), -new Date().getTimezoneOffset()).map(group => [group.start, group])), [commits]);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => searching ? commits.flatMap((commit, index) => matchesCommit(commit, query) ? [index] : []) : [], [commits, query, searching]);
  const matched = useMemo(() => new Set(matches), [matches]);
  /** Enter selects the next match and Shift+Enter the previous one, scrolling it into view. */
  const step = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setQuery(""); return; }
    if (event.key !== "Enter" || !matches.length) return;
    event.preventDefault();
    const at = commits.findIndex(commit => commit.hash === selected);
    const next = event.shiftKey ? [...matches].reverse().find(index => index < at) ?? matches[matches.length - 1]
      : matches.find(index => index > at) ?? matches[0];
    setSelected(commits[next].hash);
    list.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({block: "nearest"});
  };
  const more = async () => {
    if (!page) return;
    setLoading(true);
    try {
      const next = await api.page(copyId, commits.length);
      // Refs moved since the first page: the offset no longer lines up, so reload the whole list instead.
      if (next.revision !== page.revision) { reloadSoon(); return; }
      setCommits(current => unique(current, next.commits));
      setPage(current => current && {...current, more: next.more});
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  };
  const summary = page ? page.total + " commits on all branches" + (page.currentBranch ? " · on " + page.currentBranch : " · detached HEAD") : null;
  return <section className="git-project-code git-history-panel">
    <div className="git-project-title"><div><h2>History</h2>{summary && <p className="git-muted">{summary}</p>}</div>
      <button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); reloadSoon(); }}>{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    {!page && (error ? <p className="git-error" role="alert">{error}</p> : <p className="git-muted" role="status">Loading history…</p>)}
    {page && <div className="git-history">
    <section className="git-stack git-history-list" aria-label="History">
      <div className="git-row git-history-search">
        <input type="search" aria-label="Find in loaded commits" placeholder="Find in loaded commits" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={step}/>
        {searching && <span className="git-muted" role="status">{matches.length} match{matches.length === 1 ? "" : "es"}{page.more ? " in loaded commits" : ""}</span>}
      </div>
      <ol className="git-history-rows" ref={list} data-searching={searching || undefined}>
        {page.uncommitted.length > 0 && <li><button type="button" className="git-history-row" aria-current={selected === "working" ? "true" : undefined}
          onClick={() => setSelected("working")}>
          <span className="git-history-graph-pad" style={{width}}/><span className="git-history-subject">Uncommitted changes</span>
          <span className="git-muted">{page.uncommitted.length} file{page.uncommitted.length === 1 ? "" : "s"}</span></button></li>}
        {commits.map((commit, index) => {
          const day = days.get(index);
          const {shown, hidden} = visibleRefs(commit.refs, maxRefs);
          const conventional = conventionalPrefix(commit.subject);
          return <Fragment key={commit.hash}>
            {day && <li className="git-history-day" aria-label={day.label + ", " + day.count + " commit" + (day.count === 1 ? "" : "s")}>
              {graph && <span className="git-history-graph-clip" style={{width}}><LanesThrough row={rows[index]} width={full} height={headingHeight}/></span>}
              <strong>{day.label}</strong><span className="git-muted">{day.count}</span></li>}
            <li data-index={index} data-match={searching ? matched.has(index) || undefined : undefined}>
            <button type="button" className="git-history-row" aria-current={selected === commit.hash ? "true" : undefined} onClick={() => setSelected(commit.hash)}>
              {graph && <span className="git-history-graph-clip" style={{width}}><GraphCell row={rows[index]} width={full} head={commit.refs.some(ref => ref.isHead)}/></span>}
              <span className="git-history-text">
                {shown.length > 0 && <span className="git-history-refs">{shown.map(ref =>
                  <span key={ref.fullName} className="git-history-ref" data-kind={ref.kind} data-head={ref.isHead || undefined}>{ref.name}</span>)}
                  {hidden.length > 0 && <span className="git-history-ref git-history-more" title={hidden.map(ref => ref.name).join("\n")}
                    aria-label={hidden.length + " more: " + hidden.map(ref => ref.name).join(", ")}>+{hidden.length}</span>}</span>}
                <span className="git-history-subject">{conventional
                  ? <><span className="git-history-type">{conventional.prefix}</span>{conventional.rest}</> : commit.subject}</span>
              </span>
              <span className="git-muted git-history-meta">{commit.authorName} · <time dateTime={commit.authorDate}>{when(commit.authorDate)}</time></span>
            </button></li>
          </Fragment>;
        })}
      </ol>
      {!commits.length && !page.uncommitted.length && <p className="git-muted">No commits yet.</p>}
      {page.more && <div className="git-row"><button type="button" disabled={loading} onClick={() => void more()}>{loading ? "Loading…" : "Load older commits"}</button></div>}
      {error && <p className="git-error" role="alert">{error}</p>}
    </section>
    {selected && <ChangeView key={selected} api={api} copyId={copyId} hash={selected === "working" ? null : selected} uncommitted={page.uncommitted}/>}
    </div>}
  </section>;
}
