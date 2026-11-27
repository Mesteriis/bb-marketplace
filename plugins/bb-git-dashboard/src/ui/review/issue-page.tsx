import { useCallback, useEffect, useState } from "react";
import type { IssueAction } from "../../core/issues/model.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { message, type IssueView, type Preview, type ReviewApi } from "./review-api.ts";
import "./review.css";

/** An issue with its comments, a comment box and close/reopen; or, for `number: "new"`, the form that opens one. */
export function IssuePage({api, accountId, repo, number, onCreated}: {api: ReviewApi; accountId: string; repo: string; number: number | "new"; onCreated(number: number): void}) {
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<(Preview & {title: string; action: IssueAction}) | null>(null);
  const [comment, setComment] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(async () => {
    if (number === "new") return;
    setError("");
    try { setIssue(await api.issue({accountId, repo, number})); } catch (failure) { setError(message(failure)); }
  }, [api, accountId, repo, number]);
  useEffect(() => { setIssue(null); void load(); }, [load]);
  const act = async (action: IssueAction, label: string) => {
    setError("");
    try { setPreview({...await api.issuePrepare(accountId, repo, action), title: label, action}); } catch (failure) { setError(message(failure)); }
  };
  return <section className="git-review" aria-label={number === "new" ? "New issue in " + repo : "Issue " + repo + " #" + number}>
    {number === "new" ? <form className="git-stack" onSubmit={event => { event.preventDefault(); if (title.trim()) void act({kind: "create", title, body}, "Open issue"); }}>
      <h2>New issue <span className="git-muted">{repo}</span></h2>
      <input aria-label="Issue title" placeholder="Title" value={title} onChange={event => setTitle(event.target.value)}/>
      <textarea aria-label="Issue description" rows={6} placeholder="Description" value={body} onChange={event => setBody(event.target.value)}/>
      <div className="git-row"><button type="submit" className="git-primary" disabled={!title.trim()}>Open issue</button></div>
    </form> : !issue ? <p className={error ? "git-error" : "git-muted"} role={error ? "alert" : "status"}>{error || "Loading the issue…"}</p> : <>
      <header className="git-review-head">
        <div className="git-row"><span className="git-review-state" data-state={issue.open ? "OPEN" : "CLOSED"}>{issue.open ? "Open" : "Closed"}</span>
          <h2>{issue.title} <span className="git-muted">#{issue.number}</span></h2>
          {issue.url && <a href={issue.url} target="_blank" rel="noreferrer">Open on the forge</a>}</div>
        <p className="git-muted">{repo} · {issue.author} · {issue.createdAt.slice(0, 10)}{issue.labels.length ? " · " + issue.labels.join(", ") : ""}</p>
        <div className="git-row"><button type="button" onClick={() => void act({kind: "state", number: issue.number, open: !issue.open}, issue.open ? "Close issue" : "Reopen issue")}>
          {issue.open ? "Close issue" : "Reopen issue"}</button></div>
      </header>
      {issue.body && <article className="git-review-comment"><p className="git-review-body">{issue.body}</p></article>}
      {issue.comments.map((item, index) => <article key={index} className="git-review-comment">
        <div className="git-muted">{item.author} · {item.createdAt.slice(0, 16).replace("T", " ")}</div><p className="git-review-body">{item.body}</p></article>)}
      <form className="git-stack" onSubmit={event => { event.preventDefault(); if (comment.trim()) void act({kind: "comment", number: issue.number, body: comment}, "Comment"); }}>
        <textarea aria-label="Comment" rows={3} value={comment} onChange={event => setComment(event.target.value)} placeholder="Leave a comment"/>
        <div className="git-row"><button type="submit" disabled={!comment.trim()}>Comment</button></div>
      </form>
    </>}
    {error && issue && <p className="git-error" role="alert">{error}</p>}
    {preview && <ConfirmDialog title={preview.title} lines={preview.lines} onConfirm={async () => {
      const result = await api.issueConfirm(preview.id);
      if (preview.action.kind === "create") onCreated(result.number);
    }} onClose={done => { setPreview(null); if (done) { setComment(""); void load(); } }}/>}
  </section>;
}
