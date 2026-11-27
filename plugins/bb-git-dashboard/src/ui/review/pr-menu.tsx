import { useEffect, useState } from "react";
import { message, type PrRef, type ReviewApi } from "./review-api.ts";

/**
 * The pull request's ⋯ menu: Refresh, Copy link, Copy PR number, Link to thread…, Ask a question, Explain this PR.
 * Follows bb-github-pr-dashboard's PR menu (MIT, © 2026 Muhammad Ahsan); see THIRD_PARTY_NOTICES.md.
 */
export function PrMenu({api, target, url, onRefresh, onNotice}: {api: ReviewApi; target: PrRef; url: string; onRefresh(): void; onNotice(text: string): void}) {
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const run = (work: () => Promise<void> | void, done?: string) => {
    setOpen(false);
    Promise.resolve().then(work).then(() => { if (done) onNotice(done); }, cause => onNotice(message(cause)));
  };
  return <div className="git-pr-menu">
    <button type="button" aria-label="More pull request actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>
    {open && <div role="menu" className="git-pr-menu-list" onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <button role="menuitem" type="button" onClick={() => run(onRefresh)}>Refresh</button>
      {url && <button role="menuitem" type="button" onClick={() => run(() => api.copy(url), "Link copied.")}>Copy link</button>}
      <button role="menuitem" type="button" onClick={() => run(() => api.copy("#" + target.number), "PR number copied.")}>Copy PR number</button>
      <button role="menuitem" type="button" onClick={() => { setOpen(false); setLinking(true); }}>Link to thread…</button>
      <button role="menuitem" type="button" onClick={() => run(() => api.compose(target, "ask"))}>Ask a question</button>
      <button role="menuitem" type="button" onClick={() => run(() => api.compose(target, "explain"))}>Explain this PR</button>
    </div>}
    {linking && <LinkDialog api={api} target={target} onClose={() => setLinking(false)} onLinked={title => { setLinking(false); onNotice("Linked to " + title + "."); }}/>}
  </div>;
}

/** Link to thread: pick a thread (the PR's branch thread first) and send it the pull request as context. */
function LinkDialog({api, target, onClose, onLinked}: {api: ReviewApi; target: PrRef; onClose(): void; onLinked(title: string): void}) {
  const [threads, setThreads] = useState<{id: string; title: string; project: string}[]>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    api.linkCandidates(target).then(rows => { if (active) setThreads(rows); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, target]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (threads ?? []).filter(thread => words.every(word => (thread.title + " " + thread.project).toLowerCase().includes(word)));
  const link = async (thread: {id: string; title: string}) => {
    setPending(true); setError("");
    try { await api.link(target, thread.id); onLinked(thread.title); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <div className="git-ci-threads git-stack" role="dialog" aria-label="Link to thread">
    <input aria-label="Find a thread" autoFocus placeholder="Thread or project" value={query} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape") onClose(); }}/>
    {!threads && !error && <p className="git-muted" role="status">Reading threads…</p>}
    <ul className="git-stack">{shown.map(thread => <li key={thread.id}><button type="button" className="git-link" disabled={pending} onClick={() => void link(thread)}>
      {thread.title}</button> <span className="git-muted">{thread.project}</span></li>)}
      {threads && !shown.length && <li className="git-muted">No thread matches.</li>}</ul>
    <p className="git-muted">The thread gets the pull request as context; nothing is asked of it.</p>
    <div className="git-row"><button type="button" onClick={onClose}>Cancel</button></div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
