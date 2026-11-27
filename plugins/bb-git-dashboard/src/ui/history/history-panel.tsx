import { useEffect, useMemo, useRef, useState } from "react";
import { layoutCommitGraph } from "../../core/history/graph.ts";
import type { CommitSummary, HistoryPage } from "../../core/history/model.ts";
import { ChangeView } from "./commit-view.tsx";
import { GraphCell, graphWidth } from "./graph-cell.tsx";
import { message, type HistoryApi } from "./history-api.ts";
import "./history.css";

const watchEvery = 10_000;
const when = (value: string) => value.replace("T", " ").slice(0, 16);
const maxGraph = 220;
/** Appends commits not already listed; a page may overlap the previous one when refs moved in between. */
const unique = (current: CommitSummary[], next: CommitSummary[]) => {
  const known = new Set(current.map(commit => commit.hash));
  return [...current, ...next.filter(commit => !known.has(commit.hash))];
};

/** The graph of all refs with the working tree's changes on top; a selected commit opens its files and patches. */
export function HistoryPanel({api, copyId}: {api: HistoryApi; copyId: string}) {
  const [page, setPage] = useState<HistoryPage>();
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
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
      setPage({...first, more}); setCommits(loaded); setError("");
      setSelected(current => current ?? (first.uncommitted.length ? "working" : first.commits[0]?.hash ?? null));
    })().catch(cause => { if (active) setError(message(cause)); });
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
  const full = graphWidth(Math.max(1, ...rows.map(row => row.laneCount)));
  const width = Math.min(full, maxGraph);
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
    <div className="git-project-title"><div><h2>History</h2>{summary && <p className="git-muted">{summary}</p>}</div></div>
    {!page && (error ? <p className="git-error" role="alert">{error}</p> : <p className="git-muted" role="status">Loading history…</p>)}
    {page && <div className="git-history">
    <section className="git-stack git-history-list" aria-label="History">
      <ol className="git-history-rows">
        {page.uncommitted.length > 0 && <li><button type="button" className="git-history-row" aria-current={selected === "working" ? "true" : undefined}
          onClick={() => setSelected("working")}>
          <span className="git-history-graph-pad" style={{width}}/><span className="git-history-subject">Uncommitted changes</span>
          <span className="git-muted">{page.uncommitted.length} file{page.uncommitted.length === 1 ? "" : "s"}</span></button></li>}
        {commits.map((commit, index) => <li key={commit.hash}>
          <button type="button" className="git-history-row" aria-current={selected === commit.hash ? "true" : undefined} onClick={() => setSelected(commit.hash)}>
            <span className="git-history-graph-clip" style={{width}}><GraphCell row={rows[index]} width={full} head={commit.refs.some(ref => ref.isHead)}/></span>
            <span className="git-history-text">
              {commit.refs.length > 0 && <span className="git-history-refs">{commit.refs.map(ref =>
                <span key={ref.fullName} className="git-history-ref" data-kind={ref.kind} data-head={ref.isHead || undefined}>{ref.name}</span>)}</span>}
              <span className="git-history-subject">{commit.subject}</span>
            </span>
            <span className="git-muted git-history-meta">{commit.authorName} · <time dateTime={commit.authorDate}>{when(commit.authorDate)}</time></span>
          </button></li>)}
      </ol>
      {!commits.length && !page.uncommitted.length && <p className="git-muted">No commits yet.</p>}
      {page.more && <div className="git-row"><button type="button" disabled={loading} onClick={() => void more()}>{loading ? "Loading…" : "Load older commits"}</button></div>}
      {error && <p className="git-error" role="alert">{error}</p>}
    </section>
    {selected && <ChangeView key={selected} api={api} copyId={copyId} hash={selected === "working" ? null : selected} uncommitted={page.uncommitted}/>}
    </div>}
  </section>;
}
