import { useEffect, useMemo, useState } from "react";
import { layoutCommitGraph } from "../../core/history/graph.ts";
import type { CommitSummary, HistoryPage } from "../../core/history/model.ts";
import { ChangeView } from "./commit-view.tsx";
import { GraphCell, graphWidth } from "./graph-cell.tsx";
import { message, type HistoryApi } from "./history-api.ts";
import "./history.css";

const watchEvery = 10_000;
const when = (value: string) => value.replace("T", " ").slice(0, 16);

/** The graph of all refs with the working tree's changes on top; a selected commit opens its files and patches. */
export function HistoryPanel({api, copyId}: {api: HistoryApi; copyId: string}) {
  const [page, setPage] = useState<HistoryPage>();
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    api.page(copyId, 0).then(first => {
      if (!active) return;
      setPage(first); setCommits(first.commits); setError("");
      setSelected(current => current ?? (first.uncommitted.length ? "working" : first.commits[0]?.hash ?? null));
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, reload]);
  useEffect(() => {
    if (!page) return;
    let active = true;
    const timer = setInterval(() => api.revision(copyId).then(revision => {
      if (active && revision !== page.revision) setReload(value => value + 1);
    }, () => {}), watchEvery);
    return () => { active = false; clearInterval(timer); };
  }, [api, copyId, page]);
  const rows = useMemo(() => layoutCommitGraph(commits), [commits]);
  const width = graphWidth(Math.max(1, ...rows.map(row => row.laneCount)));
  const more = async () => {
    setLoading(true);
    try {
      const next = await api.page(copyId, commits.length);
      setCommits(current => [...current, ...next.commits]);
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
            <GraphCell row={rows[index]} width={width} head={commit.refs.some(ref => ref.isHead)}/>
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
