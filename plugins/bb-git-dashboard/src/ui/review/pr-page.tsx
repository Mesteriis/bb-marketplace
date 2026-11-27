import { useCallback, useEffect, useMemo, useState } from "react";
import type { PrAction } from "../../core/pulls/actions.ts";
import { threadFilter } from "../../core/pulls/detail.ts";
import { canSubmitReview, reviewEvents, type ReviewEvent } from "../../core/pulls/review.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { FileDiff, type DraftComment } from "./diff-view.tsx";
import { useAutoRetry } from "./auto-retry.ts";
import { RateLimited } from "./rate-limited.tsx";
import { message, type AgentDraft, type PrFileView, type PrRef, type PrView, type Preview, type ReviewApi } from "./review-api.ts";
import { ThreadView } from "./thread-view.tsx";
import { PrMenu } from "./pr-menu.tsx";
import { PrBody, PrText, PrTitle } from "./pr-text.tsx";
import "./review.css";

/** Side by side or unified, kept across pull requests and visits. */
const SPLIT_KEY = "bb-git-dashboard:pr-split";
const tabs = ["Overview", "Checks", "Files", "Commits", "Comments"] as const;
type Tab = typeof tabs[number];
const eventLabel: Record<ReviewEvent, string> = {COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes"};
const methodLabel = {merge: "Merge", squash: "Squash and merge", rebase: "Rebase and merge"} as const;
const stateLabel: Record<string, string> = {OPEN: "Open", CLOSED: "Closed", MERGED: "Merged"};

/** A pull request: header and state actions, then its discussion, checks, files with line threads, commits and threads. */
export function PrPage({api, accountId, repo, number, onStep, position, revision = 0}: {api: ReviewApi; accountId: string; repo: string; number: number; onStep?(step: -1 | 1): void;
  /** Where this pull request is in the My PRs list it was opened from (0-based); absent when opened from elsewhere. */
  position?: {index: number; total: number};
  /** Changes when an agent's answer may have arrived: the drafts are read again. */
  revision?: number}) {
  // Kept by value: a re-render of the app (an alert arriving) must not reload the page and drop a review in progress.
  const target = useMemo<PrRef>(() => ({accountId, repo, number}), [accountId, repo, number]);
  const [view, setView] = useState<PrView | null>(null);
  const [files, setFiles] = useState<PrFileView[] | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<(Preview & {title: string; kind: PrAction["kind"]; after?: () => Promise<void>}) | null>(null);
  // Agents' answers on review threads, kept for the owner to post (sent there with Fix with agent).
  const [agentDrafts, setAgentDrafts] = useState<AgentDraft[]>([]);
  const readDrafts = useCallback(() => { api.drafts(target).then(setAgentDrafts, () => {}); }, [api, target]);
  useEffect(readDrafts, [readDrafts, revision]);
  const [notice, setNotice] = useState("");
  const [comment, setComment] = useState("");
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [summary, setSummary] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [wrap, setWrap] = useState(false);
  const [split, setSplitState] = useState(() => { try { return localStorage.getItem(SPLIT_KEY) === "1"; } catch { return false; } });
  const setSplit = (value: boolean) => { setSplitState(value); try { localStorage.setItem(SPLIT_KEY, value ? "1" : "0"); } catch { /* the choice lasts for this visit */ } };
  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  // Unresolved or Resolved on Comments; null until chosen, then Unresolved while any is open.
  const [threadsShown, setThreadsShown] = useState<"unresolved" | "resolved" | null>(null);
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");

  const retry = useAutoRetry(() => void load());
  const load = useCallback(async () => {
    setError("");
    try { const next = await api.detail(target); setView(next); setMethod(next.mergeMethods[0] ?? "merge"); }
    catch (failure) { if (!retry.schedule(failure)) setError(message(failure)); }
  }, [api, target, retry.schedule]);
  useEffect(() => { setView(null); setFiles(null); setDrafts([]); setTab("Overview"); void load(); }, [load]);
  useEffect(() => {
    if (tab !== "Files" || files) return;
    api.files(target).then(setFiles, failure => setError(message(failure)));
  }, [api, target, tab, files]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return;
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "[" && onStep) onStep(-1);
      if (event.key === "]" && onStep) onStep(1);
      // On Files: j / k step through the files, n / p through the open comment threads.
      if (tab !== "Files") return;
      const step = event.key === "j" || event.key === "n" ? 1 : event.key === "k" || event.key === "p" ? -1 : 0;
      if (!step) return;
      const selector = event.key === "j" || event.key === "k" ? ".git-pr-file-diffs > .git-review-file" : ".git-pr-file-diffs .git-review-thread:not([data-resolved])";
      const targets = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (!targets.length) return;
      event.preventDefault();
      const at = targets.findIndex(target => target === document.activeElement || target.contains(document.activeElement));
      const next = targets[at === -1 ? (step > 0 ? 0 : targets.length - 1) : Math.min(targets.length - 1, Math.max(0, at + step))]!;
      next.scrollIntoView({block: "start"});
      next.focus({preventScroll: true});
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onStep, tab]);
  // Show in diff: the Files tab opens, and once its files are read the thread is brought into view.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!shown || tab !== "Files" || !files) return;
    const thread = Array.from(document.querySelectorAll<HTMLElement>(".git-pr-file-diffs .git-review-thread")).find(element => element.dataset.threadId === shown);
    setShown(null);
    thread?.scrollIntoView({block: "center"});
    thread?.focus({preventScroll: true});
  }, [shown, tab, files]);

  /** Scrolls a file of the Files tab into view and focuses it. */
  const showFile = (path: string) => {
    const section = Array.from(document.querySelectorAll<HTMLElement>(".git-pr-file-diffs > .git-review-file")).find(element => element.dataset.path === path);
    section?.scrollIntoView({block: "start"});
    section?.focus({preventScroll: true});
  };
  const act = async (action: PrAction, label: string, after?: () => Promise<void>) => {
    setNotice("");
    try { setPreview({...await api.prepare(target, action, view?.detail.headSha ?? null), title: label, kind: action.kind, after}); }
    catch (failure) { setNotice(message(failure)); }
  };
  const ask = async (subject: Parameters<ReviewApi["ask"]>[1]) => {
    setNotice("");
    try { const result = await api.ask(target, subject); setNotice(result.created ? "An agent thread was started." : "Sent to the branch's thread."); api.openThread(result.threadId); }
    catch (failure) { setNotice(message(failure)); }
  };
  if (error && !view) return <section className="git-review"><p className="git-error" role="alert">{error}</p></section>;
  if (!view) return <section className="git-review">
    {retry.left !== null ? <RateLimited left={retry.left} onNow={() => { retry.cancel(); void load(); }}/>
      : error ? <p className="git-error" role="alert">{error}</p> : <p className="git-muted" role="status">Loading the pull request…</p>}</section>;
  const {detail, capabilities: can, limitations} = view;
  const open = detail.state === "OPEN";
  const events = reviewEvents(detail.viewer, detail.author).filter(name => name === "COMMENT" || can[name === "APPROVE" ? "approve" : "requestChanges"]);
  // Drafts of your unsubmitted review are not counted: only you see them, on Files.
  const unresolved = detail.threads.filter(thread => !thread.isResolved && !thread.isPending);
  const published = detail.threads.filter(thread => !thread.isPending).length;
  const failing = detail.checks.filter(check => check.status === "failing");
  const threadCan = {reply: can.reply, resolve: can.resolve, delete: can.deleteComment};
  // Comments: Unresolved or Resolved, without the drafts of your unsubmitted review (they show under their lines on Files).
  const lists = threadFilter(detail.threads, detail.viewer, detail.author);
  const listed = threadsShown ?? (lists.unresolved.length ? "unresolved" : "resolved");
  const threadsOf = (file: PrFileView) => detail.threads.filter(thread => thread.path === file.path || (file.previousPath !== null && thread.path === file.previousPath));

  return <PrText api={api} pr={detail}><section className="git-review" aria-label={"Pull request " + detail.repo + " #" + detail.number}>
    <header className="git-review-head">
      <div className="git-row">
        <span className="git-review-state" data-state={detail.state}>{detail.isDraft && open ? "Draft" : stateLabel[detail.state] ?? detail.state}</span>
        {title === null ? <h2><PrTitle title={detail.title}/> <span className="git-muted">#{detail.number}</span></h2>
          : <form className="git-row" onSubmit={formEvent => { formEvent.preventDefault(); if (title.trim()) void act({kind: "editTitle", title}, "Rename"); }}>
            <input aria-label="Title" value={title} onChange={change => setTitle(change.target.value)}/><button type="submit">Save</button>
            <button type="button" onClick={() => setTitle(null)}>Cancel</button></form>}
        {title === null && can.editTitle && detail.canEdit && <button type="button" className="git-link" aria-label="Edit title" onClick={() => setTitle(detail.title)}>✎</button>}
        {detail.url && <a href={detail.url} target="_blank" rel="noreferrer">Open on the forge</a>}
        {position && onStep && <span className="git-row git-pr-step" role="group" aria-label="Pull requests of the list">
          <button type="button" disabled={position.index === 0} title="Previous pull request ( [ )" onClick={() => onStep(-1)}>Prev</button>
          <span className="git-muted">{position.index + 1} of {position.total}</span>
          <button type="button" disabled={position.index >= position.total - 1} title="Next pull request ( ] )" onClick={() => onStep(1)}>Next</button>
        </span>}
        <PrMenu api={api} target={target} url={detail.url} onRefresh={() => { void load(); readDrafts(); }} onNotice={setNotice}/>
      </div>
      <p className="git-muted">{detail.repo} · {detail.author} · <button type="button" className="git-link git-branch-copy" title="Copy the branch name"
        onClick={() => { api.copy(detail.headRefName); setNotice("Branch name copied."); }}><code>{detail.headRefName}</code></button> into <code>{detail.baseRefName}</code>
        {detail.additions + detail.deletions > 0 && <> · <span className="git-inbox-plus">+{detail.additions}</span> <span className="git-inbox-minus">−{detail.deletions}</span></>}
        {detail.stackedOn && <> · stacked on #{detail.stackedOn.number}</>}</p>
      <div className="git-row git-review-badges">
        {detail.conflicts && <span className="git-inbox-blocker">Merge conflicts</span>}
        {failing.length > 0 && <span className="git-inbox-blocker">CI failing ({failing.length})</span>}
        {unresolved.length > 0 && <span className="git-inbox-blocker">{unresolved.length} unresolved</span>}
        {detail.reviewers.map(item => <span key={item.name} className="git-review-tag">{item.name}: {item.state.toLowerCase().replaceAll("_", " ")}</span>)}
        {detail.labels.map(label => <span key={label.name} className="git-review-tag">{label.name}</span>)}
      </div>
      {open && <div className="git-row git-review-actions">
        {can.draft ? <button type="button" onClick={() => void act({kind: "draft", draft: !detail.isDraft}, detail.isDraft ? "Ready for review" : "Convert to draft")}>
          {detail.isDraft ? "Ready for review" : "Convert to draft"}</button> : limitations.draft && <span className="git-muted" title={limitations.draft}>Draft state: not supported</span>}
        {can.merge && <span className="git-row">
          <select aria-label="Merge method" value={method} onChange={change => setMethod(change.target.value as typeof method)}>
            {view.mergeMethods.map(name => <option key={name} value={name}>{methodLabel[name]}</option>)}</select>
          <button type="button" className="git-primary" onClick={() => void act({kind: "merge", method}, methodLabel[method])}>{methodLabel[method]}</button></span>}
        <button type="button" onClick={() => void act({kind: "state", open: false}, "Close")}>Close</button>
        {can.requestReviewer && <form className="git-row" onSubmit={formEvent => { formEvent.preventDefault(); if (reviewer.trim()) void act({kind: "requestReviewer", reviewer: reviewer.trim()}, "Request review"); }}>
          <input aria-label="Reviewer" placeholder={detail.forge === "azure" ? "Reviewer identity UUID" : "Reviewer login"} value={reviewer} onChange={change => setReviewer(change.target.value)}/>
          <button type="submit" disabled={!reviewer.trim()}>Request review</button></form>}
        {(unresolved.length > 0 || failing.length > 0) && <button type="button" onClick={() => void ask({kind: "all"})}>Fix all with agent</button>}
      </div>}
      {!open && detail.state === "CLOSED" && <div className="git-row"><button type="button" onClick={() => void act({kind: "state", open: true}, "Reopen")}>Reopen</button></div>}
      {notice && <p className="git-muted" role="status">{notice}</p>}
      {(detail.notices ?? []).length > 0 && <ul className="git-muted" aria-label="Parts not read">{detail.notices!.map(line => <li key={line}>{line}</li>)}</ul>}
      {error && <p className="git-error" role="alert">{error}</p>}
    </header>
    <nav className="git-inbox-tabs" aria-label="Pull request sections">
      {tabs.map(name => <button key={name} type="button" aria-current={name === tab ? "page" : undefined} onClick={() => setTab(name)}>{name}
        {name === "Checks" && detail.checks.length > 0 && <span className="git-inbox-count">{detail.checks.length}</span>}
        {name === "Comments" && published > 0 && <span className="git-inbox-count">{unresolved.length}/{published}</span>}
        {name === "Commits" && <span className="git-inbox-count">{detail.commitCount}</span>}</button>)}
    </nav>

    {tab === "Overview" && <div className="git-stack">
      {description === null ? can.editBody && detail.canEdit && <div className="git-row">
        <button type="button" onClick={() => setDescription(detail.body)}>Edit description</button></div>
        : <form className="git-stack" onSubmit={formEvent => { formEvent.preventDefault(); void act({kind: "editBody", body: description}, "Edit description"); }}>
          <textarea aria-label="Description" value={description} rows={8} maxLength={60_000} onChange={change => setDescription(change.target.value)}/>
          <div className="git-row"><button type="submit">Save description</button><button type="button" onClick={() => setDescription(null)}>Cancel</button></div>
        </form>}
      {detail.timeline.length === 0 && <p className="git-muted">No description or comments yet.</p>}
      {detail.timeline.map((entry, index) => <article key={index} className="git-review-comment">
        <div className="git-row git-muted">{entry.author}{entry.reviewState ? " · " + entry.reviewState.toLowerCase().replaceAll("_", " ") : ""} · {entry.createdAt.slice(0, 16).replace("T", " ")}
          {entry.canDelete && can.deleteComment && <button type="button" className="git-link-button" aria-label={"Delete " + entry.author + "'s comment"}
            onClick={() => void act({kind: "deleteComment", commentId: entry.id, threadId: null, body: entry.body.slice(0, 8000)}, "Delete comment")}>Delete</button>}</div>
        {entry.body && <PrBody content={entry.body}/>}
      </article>)}
      {can.comment && <form className="git-stack" onSubmit={formEvent => { formEvent.preventDefault(); if (comment.trim()) void act({kind: "comment", body: comment}, "Comment"); }}>
        <textarea aria-label="Comment" value={comment} onChange={change => setComment(change.target.value)} rows={3} placeholder="Leave a comment"/>
        <div className="git-row"><button type="submit" disabled={!comment.trim()}>Comment</button></div></form>}
    </div>}

    {tab === "Checks" && <ul className="git-review-checks">
      {detail.checks.length === 0 && <li className="git-muted">No checks reported.</li>}
      {detail.checks.map(check => <li key={(check.workflow ?? "") + check.name} className="git-row">
        <span className="git-state" data-state={check.status === "failing" ? "failure" : check.status === "passing" ? "success" : check.status}>{check.status}</span>
        <span>{check.workflow ? check.workflow + " › " : ""}{check.name}</span>
        {check.title && <span className="git-muted">{check.title}</span>}
        {check.url && <a href={check.url} target="_blank" rel="noreferrer">Details</a>}
        {check.status === "failing" && <button type="button" onClick={() => void ask({kind: "check", name: check.name})}>Fix with agent</button>}
      </li>)}
    </ul>}

    {tab === "Files" && <div className="git-stack">
      <div className="git-row">
        <label className="git-review-check"><input type="checkbox" checked={split} onChange={change => setSplit(change.target.checked)}/> Side by side</label>
        <label className="git-review-check"><input type="checkbox" checked={wrap} onChange={change => setWrap(change.target.checked)}/> Wrap long lines</label>
        <span className="git-muted git-review-keys">j / k files · n / p open comments</span>
        {!can.lineComment && <span className="git-muted">{limitations.lineComment}</span>}
        {drafts.length > 0 && <span className="git-muted">{drafts.length} comment{drafts.length === 1 ? "" : "s"} in your review</span>}
      </div>
      {(drafts.length > 0 || events.length > 1) && open && <form className="git-review-submit git-stack" onSubmit={formEvent => {
        formEvent.preventDefault();
        void act({kind: "review", event, body: summary, comments: drafts}, eventLabel[event]);
      }}>
        <textarea aria-label="Review summary" rows={2} value={summary} onChange={change => setSummary(change.target.value)} placeholder="Review summary"/>
        <div className="git-row">
          <select aria-label="Review outcome" value={event} onChange={change => setEvent(change.target.value as ReviewEvent)}>
            {events.map(name => <option key={name} value={name}>{eventLabel[name]}</option>)}</select>
          <button type="submit" className="git-primary" disabled={!canSubmitReview(event, summary, drafts.length)}>Submit review</button>
          {drafts.length > 0 && <button type="button" onClick={() => setDrafts([])}>Discard draft comments</button>}
        </div>
        {limitations.requestChanges && <p className="git-muted">{limitations.requestChanges}</p>}
      </form>}
      {!files ? <p className="git-muted" role="status">Loading files…</p> : files.length === 0 ? <p className="git-muted">No changed files.</p> :
        <div className="git-pr-files">
        <nav className="git-pr-file-list" aria-label="Changed files">
          {files.map(file => {
            const waiting = threadsOf(file).filter(thread => !thread.isResolved).length;
            return <button key={file.path} type="button" title={file.path} onClick={() => showFile(file.path)}>
              <span className="git-path">{file.path}</span>
              {waiting > 0 && <span className="git-review-tag" aria-label={waiting + " open comment threads"}>{waiting}</span>}
              <span className="git-inbox-plus">+{file.additions}</span><span className="git-inbox-minus">−{file.deletions}</span>
            </button>;
          })}
        </nav>
        <div className="git-stack git-pr-file-diffs">{files.map(file => <FileDiff key={file.path} file={file} wrap={wrap} split={split} canComment={open && can.lineComment} can={threadCan}
          threads={threadsOf(file)}
          act={action => void act(action, action.kind === "lineComment" ? "Line comment" : action.kind === "resolve" ? (action.resolved ? "Resolve" : "Unresolve") : action.kind === "deleteComment" ? "Delete comment" : "Reply")}
          ask={thread => void ask({kind: "thread", threadId: thread.id})} onDraft={draft => setDrafts(previous => [...previous, draft])}/>)}</div>
        </div>}
    </div>}

    {tab === "Commits" && <ul className="git-review-checks">
      {detail.commits.map(commit => <li key={commit.oid} className="git-row"><code>{commit.shortOid}</code><span>{commit.headline}</span>
        <span className="git-muted">{commit.author} · {commit.committedDate.slice(0, 10)}</span>
        {detail.myReviewOid && commit.oid === detail.myReviewOid && <span className="git-review-tag">Your last review</span>}</li>)}
    </ul>}

    {tab === "Comments" && <div className="git-stack">
      {lists.unresolved.length + lists.resolved.length > 0 ? <div className="git-row">
        <div className="git-row git-pr-thread-filter" role="group" aria-label="Thread status">
          {(["unresolved", "resolved"] as const).map(name => <button key={name} type="button" aria-pressed={listed === name} onClick={() => setThreadsShown(name)}>
            {name === "unresolved" ? "Unresolved" : "Resolved"} <span className="git-inbox-count">{lists[name].length}</span></button>)}
        </div>
        {lists.waiting && <span className="git-review-tag" data-waiting>{lists.waiting}</span>}
      </div> : <p className="git-muted">No review threads.</p>}
      {lists[listed].length === 0 && lists.unresolved.length + lists.resolved.length > 0 &&
        <p className="git-muted">{listed === "unresolved" ? "Every thread is resolved." : "No resolved threads yet."}</p>}
      {detail.threads.filter(thread => lists[listed].includes(thread.id)).map(thread => <ThreadView key={thread.id + ":" + thread.comments.length} thread={thread} can={threadCan}
        act={action => void act(action, action.kind === "resolve" ? (action.resolved ? "Resolve" : "Unresolve") : action.kind === "deleteComment" ? "Delete comment" : "Reply")}
        ask={() => void ask({kind: "thread", threadId: thread.id})} onShow={() => { setTab("Files"); setShown(thread.id); }}
        drafts={agentDrafts.filter(draft => draft.externalId === thread.id)}
        onPost={(draft, resolve) => void act({kind: "reply", threadId: thread.id, body: draft.body}, resolve ? "Post the agent's reply, then resolve" : "Post the agent's reply", async () => {
          await api.dropDraft(draft.commentId);
          readDrafts();
          // Resolving is a step of its own, confirmed like any other.
          if (resolve && thread.canToggleResolved && !thread.isResolved) await act({kind: "resolve", threadId: thread.id, resolved: true}, "Resolve");
        })}
        onEdit={async (draft, body) => { await api.editDraft(draft.commentId, body); readDrafts(); }}
        onDiscard={async draft => { await api.dropDraft(draft.commentId); readDrafts(); }}/>)}
    </div>}

    {preview && <ConfirmDialog title={preview.title} lines={preview.lines} onConfirm={async () => {
      const result = await api.confirm(preview.id);
      setNotice(result.outcome === "accepted" ? "Accepted: the forge finishes it shortly." : "Done.");
    }} onClose={done => {
      const after = preview.after;
      setPreview(null);
      if (done && after) after().catch(failure => setNotice(message(failure)));
      if (done) { setComment(""); setTitle(null); setDescription(null); setReviewer(""); if (preview.kind === "review") { setDrafts([]); setSummary(""); } setFiles(null); void load(); }
    }}/>}
  </section></PrText>;
}
