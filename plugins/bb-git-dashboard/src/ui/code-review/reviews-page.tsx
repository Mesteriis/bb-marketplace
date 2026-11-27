import { useCallback, useEffect, useState } from "react";
import { message } from "./review-api.ts";

export type ReviewSummary = {sessionId: string; copyId: string; copyName: string | null; orphan: boolean; targetKey: string; view: string;
  open: number; total: number; updatedAt: number};
export type ReviewsApi = {
  summaries(): Promise<ReviewSummary[]>;
  deleteOrphans(sessionIds: string[]): Promise<{deleted: number; deletedThreads: number}>;
};

/**
 * Every review that has comment threads, newest first: its working copy and view, with open and total counts. A
 * review whose working copy is gone (an orphan) can be deleted, after confirming. Follows diff-review
 * app/reviews-page.tsx and app/orphans.tsx (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
export function ReviewsPage({api, revision, onOpen}: {api: ReviewsApi; revision: number; onOpen(copyId: string, targetKey: string): void}) {
  const [reviews, setReviews] = useState<ReviewSummary[]>();
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState("");
  const load = useCallback(() => api.summaries().then(rows => { setReviews(rows); setError(""); }, cause => setError(message(cause))), [api]);
  useEffect(() => { void load(); }, [load, revision]);
  const orphans = reviews?.filter(row => row.orphan) ?? [];
  const live = reviews?.filter(row => !row.orphan) ?? [];
  const remove = async () => {
    try {
      const {deleted, deletedThreads} = await api.deleteOrphans(chosen);
      setStatus("Deleted " + deleted + " review" + (deleted === 1 ? "" : "s") + " with " + deletedThreads + " comment thread" + (deletedThreads === 1 ? "" : "s") + ".");
      setChosen([]); setConfirming(false);
    } catch (cause) { setStatus("Could not delete: " + message(cause)); }
    await load();
  };
  const when = (at: number) => new Date(at).toLocaleString();
  return <section className="git-stack git-code-review git-reviews-page" aria-label="Reviews">
    <h2>Reviews</h2>
    {error && <p className="git-error" role="alert">{error}</p>}
    {!reviews && !error && <p className="git-muted" role="status">Reading the reviews…</p>}
    {status && <p className="git-muted" role="status">{status}</p>}
    {reviews && !reviews.length && <p className="git-muted">No review has comments yet. Comment on a working copy's diff in its Review section.</p>}
    {live.length > 0 && <ul className="git-stack">{live.map(row => <li key={row.sessionId} className="git-code-review-run">
      <div className="git-row">
        <button type="button" className="git-link" onClick={() => onOpen(row.copyId, row.targetKey)}><strong>{row.copyName}</strong> · {row.view}</button>
        <span className="git-ci-spacer"/>
        <span className="git-review-tag" data-waiting={row.open > 0 || undefined}>{row.open ? row.open + " open of " + row.total : row.total + " closed"}</span>
        <span className="git-muted">{when(row.updatedAt)}</span>
      </div>
    </li>)}</ul>}
    {orphans.length > 0 && <section className="git-stack" aria-label="Reviews of working copies that are gone">
      <h3>Reviews of working copies that are gone</h3>
      <p className="git-muted">Their working copy is no longer attached, so they cannot be opened. Delete the ones you no longer need.</p>
      <ul className="git-stack">{orphans.map(row => <li key={row.sessionId}><label className="git-row">
        <input type="checkbox" checked={chosen.includes(row.sessionId)}
          onChange={() => setChosen(value => value.includes(row.sessionId) ? value.filter(id => id !== row.sessionId) : [...value, row.sessionId])}/>
        <span>{row.view}</span><span className="git-muted">{row.total} comment thread{row.total === 1 ? "" : "s"} · {when(row.updatedAt)}</span>
      </label></li>)}</ul>
      {!confirming ? <div className="git-row"><button type="button" disabled={!chosen.length} onClick={() => setConfirming(true)}>Delete {chosen.length || ""}</button></div>
        : <div className="git-ci-threads git-stack" role="alertdialog" aria-label="Delete reviews">
          <p>Delete {chosen.length} review{chosen.length === 1 ? "" : "s"} with all their comments? This cannot be undone.</p>
          <div className="git-row">
            <button type="button" className="git-danger" onClick={() => void remove()}>Delete</button>
            <button type="button" autoFocus onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>}
    </section>}
  </section>;
}
