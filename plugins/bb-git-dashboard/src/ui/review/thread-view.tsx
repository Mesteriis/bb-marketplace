import { useMemo, useState } from "react";
import type { PrAction } from "../../core/pulls/actions.ts";
import { message, type AgentDraft, type PrDetailView } from "./review-api.ts";
import { PrBody } from "./pr-text.tsx";
import { parsePatch } from "../../core/pulls/diff.ts";
import { CodeText, useHighlight } from "../highlight/use-highlight.tsx";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { ago } from "../../core/i18n/time.ts";
import { threadStatus } from "../../core/pulls/detail.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";

type Thread = PrDetailView["threads"][number];

/**
 * One review thread: its comments in Markdown, a reply box, resolve, and Fix with agent; under it the answers an
 * agent left as drafts, to post (each after confirming), edit or discard.
 */
/** The few lines of diff a thread was left on, painted like the diff itself. */
export function HunkSnippet({path, hunk}: {path: string; hunk: string}) {
  const t = useT();
  const rows = useMemo(() => parsePatch(hunk), [hunk]);
  const tokensOf = useHighlight(path, rows, true);
  return <div className="git-review-diff git-review-snippet" role="group" aria-label={t("tv.snippet", {path})}>
    {rows.map((row, index) => <div key={index} className="git-review-row" data-kind={row.kind}>
      {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
        <span className="git-review-number">{row.oldLine ?? ""}</span><span className="git-review-number">{row.newLine ?? ""}</span>
        <code className="git-review-code">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}<CodeText text={row.text} tokens={tokensOf(index)}/></code>
      </>}
    </div>)}
  </div>;
}

export function ThreadView({thread, can, act, ask, showPath = true, drafts = [], onPost, onEdit, onDiscard, onShow, people}: {
  thread: Thread; can: {reply: boolean; resolve: boolean; delete?: boolean}; act(action: PrAction): void; ask(): void; showPath?: boolean;
  drafts?: AgentDraft[]; onPost?(draft: AgentDraft, resolve: boolean): void; onEdit?(draft: AgentDraft, body: string): Promise<void>; onDiscard?(draft: AgentDraft): Promise<void>;
  /** Where the thread is read away from the diff: its diff fragment shows, and Show in diff goes to its line. */
  onShow?(): void;
  /** On a pull request: who reads it and who wrote it, so the waiting tag says on whom, as the Comments tab does. */
  people?: {viewer: string; author: string};
}) {
  const t = useT();
  const {language} = useLanguage();
  const [reply, setReply] = useState("");
  // A comment of an unsubmitted review exists only for its author until submitted on the forge.
  const live = !thread.isPending;
  const where = thread.line === null ? "" : thread.startLine ? t("tv.lines", {from: thread.startLine, to: thread.line}) : t("tv.line", {n: thread.line});
  return <article className="git-review-thread" data-resolved={thread.isResolved || undefined} data-thread-id={thread.id} tabIndex={-1}
    aria-label={t("tv.region", {path: thread.path + where})}>
    <header className="git-row">
      {showPath && <strong className="git-path">{thread.path}{where}{thread.side === "LEFT" ? t("tv.old") : ""}</strong>}
      {thread.isOutdated && <span className="git-review-tag">{t("pr.outdated")}</span>}
      {thread.isResolved && <span className="git-review-tag">{thread.resolvedBy ? t("pr.resolved-by", {name: thread.resolvedBy}) : t("pr.resolved")}</span>}
      {!thread.isResolved && thread.awaitingReply && <span className="git-review-tag" data-waiting>
        {people ? t(("pr.st." + threadStatus(thread, people.viewer, people.author)) as MessageKey) : t("pr.waiting-author")}</span>}
      {thread.isPending && <span className="git-review-tag">{t("pr.pending-review")}</span>}
      {onShow && <button type="button" className="git-review-show" onClick={onShow}>{t("tv.show")}</button>}
    </header>
    {onShow && thread.diffHunk && <HunkSnippet path={thread.path} hunk={thread.diffHunk}/>}
    {thread.comments.map((comment, index) => <div key={comment.id || index} className="git-review-comment">
      <div className="git-row git-muted">{comment.author} · <time dateTime={comment.createdAt}
        title={comment.createdAt.slice(0, 16).replace("T", " ")}>{ago(language, Date.now(), comment.createdAt)}</time>
        {comment.canDelete && can.delete && <button type="button" className="git-link-button" aria-label={t("pr.delete-comment", {author: comment.author})}
          onClick={() => act({kind: "deleteComment", commentId: comment.id, threadId: thread.id, body: comment.body.slice(0, 8000)})}>{t("pr.delete")}</button>}</div>
      <PrBody content={comment.body}/>
    </div>)}
    {drafts.map(draft => <AgentDraftCard key={draft.commentId} draft={draft} canPost={live && can.reply} canResolve={live && can.resolve && thread.canToggleResolved && !thread.isResolved}
      onPost={resolve => onPost?.(draft, resolve)} onEdit={body => onEdit ? onEdit(draft, body) : Promise.resolve()} onDiscard={() => onDiscard ? onDiscard(draft) : Promise.resolve()}/>)}
    <form className="git-row git-review-reply" onSubmit={event => { event.preventDefault(); if (reply.trim()) act({kind: "reply", threadId: thread.id, body: reply}); }}>
      {live && can.reply && <input aria-label={t("pr.reply-in", {path: thread.path})} placeholder={t("pr.reply")} value={reply} onChange={event => setReply(event.target.value)}/>}
      {live && can.reply && <button type="submit" disabled={!reply.trim()}>{t("pr.reply")}</button>}
      {live && can.resolve && thread.canToggleResolved && <button type="button" onClick={() => act({kind: "resolve", threadId: thread.id, resolved: !thread.isResolved})}>
        {thread.isResolved ? t("pr.unresolve") : t("pr.resolve")}</button>}
      {live && !thread.isResolved && <button type="button" onClick={ask}>{t("pr.fix-agent")}</button>}
    </form>
  </article>;
}

/** An agent's answer kept for the owner: Post, Post and resolve, Edit, Discard. The text is shown as written. */
function AgentDraftCard({draft, canPost, canResolve, onPost, onEdit, onDiscard}: {draft: AgentDraft; canPost: boolean; canResolve: boolean;
  onPost(resolve: boolean): void; onEdit(body: string): Promise<void>; onDiscard(): Promise<void>}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = (work: Promise<void>) => { setError(""); work.catch(cause => setError(message(cause))); };
  return <div className="git-review-comment git-review-draft" aria-label={t("pr.draft-by", {name: draft.authorName})}>
    <div className="git-row"><strong>{draft.authorName}</strong><span className="git-review-tag" data-waiting>
      {draft.draft === "resolve" ? t("tv.draft-resolves") : t("tv.draft")}</span><span className="git-muted">{t("tv.not-posted")}</span></div>
    {editing === null ? <p className="git-review-body">{draft.body}</p>
      : <textarea aria-label={t("pr.draft-edit")} value={editing} rows={3} onChange={event => setEditing(event.target.value)}/>}
    <div className="git-row">
      {editing === null ? <>
        {canPost && <button type="button" className="git-primary" onClick={() => onPost(false)}>{t("tv.post")}</button>}
        {canPost && canResolve && <button type="button" onClick={() => onPost(true)}>{t("tv.post-resolve")}</button>}
        <button type="button" onClick={() => setEditing(draft.body)}>{t("pr.edit")}</button>
        <button type="button" onClick={() => run(onDiscard())}>{t("pr.discard")}</button>
      </> : <>
        <button type="button" disabled={!editing.trim()} onClick={() => run(onEdit(editing).then(() => setEditing(null)))}>{t("pr.save")}</button>
        <button type="button" onClick={() => setEditing(null)}>{t("pr.cancel")}</button>
      </>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
