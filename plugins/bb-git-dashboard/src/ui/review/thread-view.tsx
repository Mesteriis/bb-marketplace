import { useMemo, useState } from "react";
import type { PrAction } from "../../core/pulls/actions.ts";
import { message, type AgentDraft, type PrDetailView } from "./review-api.ts";
import { PrBody } from "./pr-text.tsx";
import { parsePatch } from "../../core/pulls/diff.ts";
import { CodeText, useHighlight } from "../highlight/use-highlight.tsx";

type Thread = PrDetailView["threads"][number];

/**
 * One review thread: its comments in Markdown, a reply box, resolve, and Fix with agent; under it the answers an
 * agent left as drafts, to post (each after confirming), edit or discard.
 */
/** The few lines of diff a thread was left on, painted like the diff itself. */
function HunkSnippet({path, hunk}: {path: string; hunk: string}) {
  const rows = useMemo(() => parsePatch(hunk), [hunk]);
  const tokensOf = useHighlight(path, rows, true);
  return <div className="git-review-diff git-review-snippet" role="group" aria-label={"Diff around the comment on " + path}>
    {rows.map((row, index) => <div key={index} className="git-review-row" data-kind={row.kind}>
      {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
        <span className="git-review-number">{row.oldLine ?? ""}</span><span className="git-review-number">{row.newLine ?? ""}</span>
        <code className="git-review-code">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}<CodeText text={row.text} tokens={tokensOf(index)}/></code>
      </>}
    </div>)}
  </div>;
}

export function ThreadView({thread, can, act, ask, showPath = true, drafts = [], onPost, onEdit, onDiscard, onShow}: {
  thread: Thread; can: {reply: boolean; resolve: boolean; delete?: boolean}; act(action: PrAction): void; ask(): void; showPath?: boolean;
  drafts?: AgentDraft[]; onPost?(draft: AgentDraft, resolve: boolean): void; onEdit?(draft: AgentDraft, body: string): Promise<void>; onDiscard?(draft: AgentDraft): Promise<void>;
  /** Where the thread is read away from the diff: its diff fragment shows, and Show in diff goes to its line. */
  onShow?(): void;
}) {
  const [reply, setReply] = useState("");
  // A comment of an unsubmitted review exists only for its author until submitted on the forge.
  const live = !thread.isPending;
  const where = thread.line === null ? "" : thread.startLine ? " lines " + thread.startLine + "–" + thread.line : " line " + thread.line;
  return <article className="git-review-thread" data-resolved={thread.isResolved || undefined} data-thread-id={thread.id} tabIndex={-1}
    aria-label={"Comment thread on " + thread.path + where}>
    <header className="git-row">
      {showPath && <strong className="git-path">{thread.path}{where}{thread.side === "LEFT" ? " (old)" : ""}</strong>}
      {thread.isOutdated && <span className="git-review-tag">Outdated</span>}
      {thread.isResolved && <span className="git-review-tag">Resolved{thread.resolvedBy ? " by " + thread.resolvedBy : ""}</span>}
      {!thread.isResolved && thread.awaitingReply && <span className="git-review-tag" data-waiting>Waiting for the author</span>}
      {thread.isPending && <span className="git-review-tag">Pending review</span>}
      {onShow && <button type="button" className="git-review-show" onClick={onShow}>Show in diff</button>}
    </header>
    {onShow && thread.diffHunk && <HunkSnippet path={thread.path} hunk={thread.diffHunk}/>}
    {thread.comments.map((comment, index) => <div key={comment.id || index} className="git-review-comment">
      <div className="git-row git-muted">{comment.author} · {comment.createdAt.slice(0, 16).replace("T", " ")}
        {comment.canDelete && can.delete && <button type="button" className="git-link-button" aria-label={"Delete " + comment.author + "'s comment"}
          onClick={() => act({kind: "deleteComment", commentId: comment.id, threadId: thread.id, body: comment.body.slice(0, 8000)})}>Delete</button>}</div>
      <PrBody content={comment.body}/>
    </div>)}
    {drafts.map(draft => <AgentDraftCard key={draft.commentId} draft={draft} canPost={live && can.reply} canResolve={live && can.resolve && thread.canToggleResolved && !thread.isResolved}
      onPost={resolve => onPost?.(draft, resolve)} onEdit={body => onEdit ? onEdit(draft, body) : Promise.resolve()} onDiscard={() => onDiscard ? onDiscard(draft) : Promise.resolve()}/>)}
    <form className="git-row git-review-reply" onSubmit={event => { event.preventDefault(); if (reply.trim()) act({kind: "reply", threadId: thread.id, body: reply}); }}>
      {live && can.reply && <input aria-label={"Reply in " + thread.path} placeholder="Reply" value={reply} onChange={event => setReply(event.target.value)}/>}
      {live && can.reply && <button type="submit" disabled={!reply.trim()}>Reply</button>}
      {live && can.resolve && thread.canToggleResolved && <button type="button" onClick={() => act({kind: "resolve", threadId: thread.id, resolved: !thread.isResolved})}>
        {thread.isResolved ? "Unresolve" : "Resolve"}</button>}
      {live && !thread.isResolved && <button type="button" onClick={ask}>Fix with agent</button>}
    </form>
  </article>;
}

/** An agent's answer kept for the owner: Post, Post and resolve, Edit, Discard. The text is shown as written. */
function AgentDraftCard({draft, canPost, canResolve, onPost, onEdit, onDiscard}: {draft: AgentDraft; canPost: boolean; canResolve: boolean;
  onPost(resolve: boolean): void; onEdit(body: string): Promise<void>; onDiscard(): Promise<void>}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = (work: Promise<void>) => { setError(""); work.catch(cause => setError(message(cause))); };
  return <div className="git-review-comment git-review-draft" aria-label={"Draft reply by " + draft.authorName}>
    <div className="git-row"><strong>{draft.authorName}</strong><span className="git-review-tag" data-waiting>
      {draft.draft === "resolve" ? "Draft reply · resolves" : "Draft reply"}</span><span className="git-muted">not posted yet</span></div>
    {editing === null ? <p className="git-review-body">{draft.body}</p>
      : <textarea aria-label="Edit the draft reply" value={editing} rows={3} onChange={event => setEditing(event.target.value)}/>}
    <div className="git-row">
      {editing === null ? <>
        {canPost && <button type="button" className="git-primary" onClick={() => onPost(false)}>Post</button>}
        {canPost && canResolve && <button type="button" onClick={() => onPost(true)}>Post and resolve</button>}
        <button type="button" onClick={() => setEditing(draft.body)}>Edit</button>
        <button type="button" onClick={() => run(onDiscard())}>Discard</button>
      </> : <>
        <button type="button" disabled={!editing.trim()} onClick={() => run(onEdit(editing).then(() => setEditing(null)))}>Save</button>
        <button type="button" onClick={() => setEditing(null)}>Cancel</button>
      </>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
