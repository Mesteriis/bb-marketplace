import { useState } from "react";
import { en, type MessageKey } from "../../core/i18n/dictionary.ts";
import type { PrForms } from "./pr-forms.ts";
import { ago } from "../../core/i18n/time.ts";
import type { PrAction } from "../../core/pulls/actions.ts";
import { threadFilter, threadStatus } from "../../core/pulls/detail.ts";
import { canSubmitReview, reviewEvents, type ReviewEvent } from "../../core/pulls/review.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import type { DraftComment } from "./diff-view.tsx";
import { initials } from "./pr-overview.tsx";
import { PrBody } from "./pr-text.tsx";
import { HunkSnippet } from "./thread-view.tsx";
import { message, type AgentDraft, type PrDetailView, type PrView } from "./review-api.ts";

type Thread = PrDetailView["threads"][number];
type Shown = "open" | "resolved" | "all";
const statusTone: Record<string, string> = {"waiting-on-you": "warn", "waiting-on-author": "warn", "you-replied": "line", "author-replied": "vio", resolved: "good"};

/**
 * Comments: the review threads, open, resolved or all, each as a row: where, its state, who said what, and what to do —
 * reply, resolve, fix with an agent, go to the line. An agent's draft answer stands in the reply's place: Send (after
 * the confirmation), Edit in place, Discard. Beside them your review: its outcome, a summary, the line comments it takes.
 */
export function PrComments({view, forms, form, drafts, lineDrafts, act, ask, onShow, onPost, onEdit, onDiscard, onSubmit, onDropLineDrafts}: {view: PrView;
  forms: PrForms; form(patch: Partial<PrForms>): void; drafts: AgentDraft[];
  lineDrafts: DraftComment[]; act(action: PrAction): void; ask(thread: Thread): void; onShow(thread: Thread): void;
  onPost(thread: Thread, draft: AgentDraft, resolve: boolean): void; onEdit(draft: AgentDraft, body: string): Promise<void>; onDiscard(draft: AgentDraft): Promise<void>;
  onSubmit(event: ReviewEvent, summary: string): void; onDropLineDrafts(): void}) {
  const t = useT();
  const {detail, capabilities: can, limitations} = view;
  const lists = threadFilter(detail.threads, detail.viewer, detail.author);
  const shown: Shown = forms.threads ?? (lists.unresolved.length ? "open" : "all");
  const ids = new Set(shown === "open" ? lists.unresolved : shown === "resolved" ? lists.resolved : [...lists.unresolved, ...lists.resolved]);
  const threads = detail.threads.filter(thread => ids.has(thread.id));
  const total = lists.unresolved.length + lists.resolved.length;
  const open = detail.state === "OPEN";
  const own = !!detail.viewer && detail.viewer === detail.author;
  const allowed = reviewEvents(detail.viewer, detail.author).filter(name => name === "COMMENT" || can[name === "APPROVE" ? "approve" : "requestChanges"]);
  const {event, summary} = forms;
  return <div className="git-pr-overview">
    <div className="git-pr-main">
      <div className="git-pr-bar git-pr-bar-flat">
        {total > 0 ? <div className="g-seg" role="group" aria-label={t("pr.threads")}>
          {(["open", "resolved", "all"] as const).map(name => <button key={name} type="button" aria-pressed={shown === name} onClick={() => form({threads: name})}>
            {t(("pr.t." + name) as MessageKey)} <span className="g-num">{name === "open" ? lists.unresolved.length : name === "resolved" ? lists.resolved.length : total}</span></button>)}
        </div> : <span className="g-muted">{t("pr.no-threads")}</span>}
        {lists.waitingCount > 0 && <span className="g-chip warn" data-waiting>{own ? t("pr.waiting-yours", {n: lists.waitingCount})
          : t("pr.answered-by", {n: lists.waitingCount, author: detail.author})}</span>}
        <span className="g-muted git-pr-bar-end git-inbox-keys"><kbd className="g-kbd">n</kbd> <kbd className="g-kbd">p</kbd> {t("pr.t-keys")}</span>
      </div>
      {total > 0 && threads.length === 0 && <p className="g-muted">{shown === "open" ? t("pr.all-resolved") : t("pr.none-resolved")}</p>}
      <ul className="git-pr-threads">{threads.map(thread => <ThreadRow key={thread.id + ":" + thread.comments.length} thread={thread} view={view}
        drafts={drafts.filter(draft => draft.externalId === thread.id)} act={act} ask={() => ask(thread)} onShow={() => onShow(thread)}
        onPost={(draft, resolve) => onPost(thread, draft, resolve)} onEdit={onEdit} onDiscard={onDiscard}/>)}</ul>
    </div>
    <aside className="git-pr-side" aria-label={t("pr.your-review")}>
      {open && <section>
        <h3 className="g-sec">{t("pr.your-review")}</h3>
        {own && <p className="g-muted">{t("pr.own")}</p>}
        <div className="g-seg" role="group" aria-label={t("pr.outcome")}>
          {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map(name => {
            const off = !allowed.includes(name);
            return <button key={name} type="button" aria-pressed={event === name} disabled={off} title={off ? (own ? t("pr.event-off") : t("pr.event-unsupported")) : undefined}
              onClick={() => form({event: name})}>{t(("pr.ev." + name) as MessageKey)}</button>;
          })}
        </div>
        <textarea className="git-pr-summary" aria-label={t("pr.summary")} rows={4} value={summary} placeholder={t("pr.summary-placeholder")} onChange={change => form({summary: change.target.value})}/>
        {limitations.requestChanges && <p className="g-muted">{limitations.requestChanges}</p>}
        <div className="git-pr-form-row">
          <span className="g-muted">{lineDrafts.length ? t("pr.into-review", {n: lineDrafts.length}) : ""}</span>
          <button type="button" className="g-btn pri" disabled={!canSubmitReview(event, summary, lineDrafts.length)}
            onClick={() => { onSubmit(event, summary); }}>{t("pr.submit")}</button>
        </div>
        {lineDrafts.length > 0 && <button type="button" className="g-btn ghost sm" onClick={onDropLineDrafts}>{t("pr.discard-drafts")}</button>}
      </section>}
      <section>
        <h3 className="g-sec">{t("pr.participants")}</h3>
        {detail.reviewers.length ? <ul className="git-pr-people">{detail.reviewers.map(item => <li key={item.name}>
          <span className="git-pr-avatar" aria-hidden="true">{initials(item.name)}</span><span>{item.name}</span>
          <span className={"g-chip " + (item.state === "APPROVED" ? "good" : item.state === "CHANGES_REQUESTED" ? "warn" : "line")}>
            {("pr.rs." + item.state) in en ? t(("pr.rs." + item.state) as MessageKey) : item.state.toLowerCase().replaceAll("_", " ")}</span>
        </li>)}</ul> : <p className="g-muted">{t("pr.no-reviewers")}</p>}
      </section>
    </aside>
  </div>;
}

function ThreadRow({thread, view, drafts, act, ask, onShow, onPost, onEdit, onDiscard}: {thread: Thread; view: PrView; drafts: AgentDraft[]; act(action: PrAction): void;
  ask(): void; onShow(): void; onPost(draft: AgentDraft, resolve: boolean): void; onEdit(draft: AgentDraft, body: string): Promise<void>; onDiscard(draft: AgentDraft): Promise<void>}) {
  const t = useT();
  const {language} = useLanguage();
  const {detail, capabilities: can} = view;
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const live = !thread.isPending;
  const where = thread.line === null ? "" : ":" + (thread.startLine ? thread.startLine + "–" : "") + thread.line;
  const status = threadStatus(thread, detail.viewer, detail.author);
  const last = thread.comments[thread.comments.length - 1];
  const draft = drafts[0];
  const [editingId, setEditingId] = useState<string | null>(null);
  const canResolve = live && can.resolve && thread.canToggleResolved;
  const run = (work: Promise<void>) => { setError(""); work.catch(cause => setError(message(cause))); };
  return <li className="git-pr-thread" data-thread-id={thread.id} data-resolved={thread.isResolved || undefined} tabIndex={-1}>
    <article aria-label={t("pr.thread-on", {path: thread.path + (thread.line === null ? "" : ":" + thread.line)})}>
      <header className="git-pr-thread-head">
        <Icon name="MessageSquare" small/>
        <span className="g-mono">{thread.path}{where}</span>
        {thread.isPending ? <span className="g-chip line">{t("pr.pending-review")}</span>
          : <span className={"g-chip " + (statusTone[status] ?? "line")}>{status === "resolved" && thread.resolvedBy ? t("pr.resolved-by", {name: thread.resolvedBy}) : t(("pr.st." + status) as MessageKey)}</span>}
        {thread.isOutdated && <span className="g-chip line">{t("pr.outdated")}</span>}
        <span className="g-muted git-pr-bar-end">{last ? ago(language, Date.now(), last.createdAt) : ""}{draft ? " · " + t("pr.agent-draft") : ""}</span>
      </header>
      {thread.diffHunk && <div className="git-pr-thread-snippet"><HunkSnippet path={thread.path} hunk={thread.diffHunk}/></div>}
      {thread.comments.map((comment, index) => <div key={comment.id || index} className="git-pr-thread-comment">
        <strong>{comment.author}</strong> <PrBody content={comment.body}/>
        {comment.canDelete && can.deleteComment && <button type="button" className="g-btn ghost sm" aria-label={t("pr.delete-comment", {author: comment.author})}
          onClick={() => act({kind: "deleteComment", commentId: comment.id, threadId: thread.id, body: comment.body.slice(0, 8000)})}>{t("pr.delete")}</button>}
      </div>)}
      {drafts.map(item => <div key={item.commentId} className="git-pr-thread-actions git-pr-draft" role="group" aria-label={t("pr.draft-by", {name: item.authorName})}>
        {editingId !== item.commentId ? <>
          <span className="git-pr-draft-text" title={item.body}>{item.body}</span>
          {live && can.reply && <button type="button" className="g-btn pri sm" onClick={() => onPost(item, false)}><Icon name="Sent" small/>{t("pr.send")}</button>}
          {live && can.reply && canResolve && !thread.isResolved && <button type="button" className="g-btn sm" onClick={() => onPost(item, true)}>{t("pr.send-resolve")}</button>}
          <button type="button" className="g-btn ghost sm" onClick={() => { setEditingId(item.commentId); setEditing(item.body); }}>{t("pr.edit")}</button>
          <button type="button" className="g-btn ghost sm" onClick={() => run(onDiscard(item))}>{t("pr.discard")}</button>
        </> : <>
          <textarea className="git-pr-draft-edit" aria-label={t("pr.draft-edit")} value={editing ?? ""} rows={3} onChange={change => setEditing(change.target.value)}/>
          <button type="button" className="g-btn sm" disabled={!editing?.trim()} onClick={() => run(onEdit(item, editing ?? "").then(() => { setEditingId(null); setEditing(null); }))}>{t("pr.save")}</button>
          <button type="button" className="g-btn ghost sm" onClick={() => { setEditingId(null); setEditing(null); }}>{t("pr.cancel")}</button>
        </>}
      </div>)}
      <form className="git-pr-thread-actions" onSubmit={submit => { submit.preventDefault(); if (reply.trim()) act({kind: "reply", threadId: thread.id, body: reply}); }}>
        {live && can.reply && <input className="g-inp" aria-label={t("pr.reply-in", {path: thread.path})} placeholder={t("pr.reply")} value={reply} onChange={change => setReply(change.target.value)}/>}
        {live && can.reply && reply.trim() && <button type="submit" className="g-btn sm">{t("pr.reply")}</button>}
        {canResolve && <button type="button" className="g-btn sm" onClick={() => act({kind: "resolve", threadId: thread.id, resolved: !thread.isResolved})}>
          {thread.isResolved ? t("pr.unresolve") : t("pr.resolve")}</button>}
        {live && !thread.isResolved && <button type="button" className={"g-btn sm" + (draft ? "" : " pri")} onClick={ask}><Icon name="Bot" small/>{t("pr.fix-agent")}</button>}
        <button type="button" className="g-btn ghost sm" onClick={onShow}>{t("pr.to-line")} <Icon name="ChevronRight" small/></button>
      </form>
      {error && <p className="g-bad" role="alert">{error}</p>}
    </article>
  </li>;
}
