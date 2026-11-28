import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { Draft } from "../../core/code-review/view-state.ts";
import { useKept } from "./kept-state.tsx";
import { SEVERITY_OPTIONS } from "./severity.ts";
import { describeLocation, type ReviewComment, type ReviewThread, type Severity } from "../../core/code-review/model.ts";
import { bodyParts, insertSuggestion, suggestionLines, suggestionState } from "../../core/code-review/suggestion.ts";
import { message, type CodeReviewApi } from "./review-api.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { useT } from "../i18n/use-t.tsx";

const severityKey = (severity: Severity) => ("cr.sev." + severity) as MessageKey;
const deliveryKey = (state: string) => ("cr.del." + state) as MessageKey;

/**
 * A comment box: ⌘/Ctrl+Enter sends, Escape cancels; "Suggest a change" adds a suggestion block seeded with the
 * commented lines. `severity` is offered on a new thread only.
 */
export function Composer({label, initial = "", code, withSeverity, submitLabel, onSubmit, onCancel, draftKey, draftRange, where, extra}: {
  label: string; initial?: string; code?: string | null; withSeverity?: boolean; submitLabel: string;
  /** Where the comment goes ("line 28"), on the right of its head. */
  where?: string;
  /** A further action beside the comment's own (Explain these lines). */
  extra?: ReactNode;
  onSubmit(body: string, severity: Severity | null): Promise<void>; onCancel?(): void;
  /** Where the unsent text is kept (see view-state.ts), so it survives leaving the thread. */
  draftKey?: string; draftRange?: Draft["range"];
}) {
  const t = useT();
  const kept = useKept();
  const saved = draftKey ? kept.draft(draftKey) : undefined;
  const [body, setBodyState] = useState(saved?.body ?? initial);
  const [severity, setSeverityState] = useState<Severity | "">(saved?.severity ?? "");
  const keep = (nextBody: string, nextSeverity: Severity | "") => {
    if (draftKey) kept.setDraft(draftKey, nextBody === initial ? null : {body: nextBody, severity: nextSeverity || null, ...draftRange ? {range: draftRange} : {}});
  };
  const setBody = (value: string | ((current: string) => string)) => setBodyState(current => {
    const next = typeof value === "function" ? value(current) : value;
    keep(next, severity);
    return next;
  });
  const setSeverity = (value: Severity | "") => { setSeverityState(value); keep(body, value); };
  const cancel = onCancel && (() => { if (draftKey) kept.setDraft(draftKey, null); onCancel(); });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!body.trim() || pending) return;
    setPending(true); setError("");
    try { await onSubmit(body, severity || null); setBodyState(""); if (draftKey) kept.setDraft(draftKey, null); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    if (event.key === "Escape" && cancel) { event.preventDefault(); cancel(); }
  };
  return <form className="git-review-composer git-cr-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {(withSeverity || where) && <div className="git-cr-composer-head">
      {withSeverity && <div className="g-seg" role="group" aria-label={t("cr.severity")}>{SEVERITY_OPTIONS.map(value =>
        <button key={value} type="button" aria-pressed={severity === value} onClick={() => setSeverity(severity === value ? "" : value)}>{t(severityKey(value))}</button>)}</div>}
      {where && <span className="g-muted git-cr-where">{where}</span>}
    </div>}
    <textarea className="g-inp" aria-label={label} value={body} rows={3} autoFocus placeholder={t("cr.placeholder")}
      onChange={event => setBody(event.target.value)} onKeyDown={keys}/>
    <div className="git-cr-composer-bar">
      <button type="submit" className="g-btn pri" disabled={pending || !body.trim()}>{pending ? t("cr.saving") : submitLabel}</button>
      {code !== undefined && code !== null && <button type="button" className="g-btn" onClick={() => setBody(current => insertSuggestion(current, current.length, code).body)}>{t("cr.suggest")}</button>}
      {cancel && <button type="button" className="g-btn ghost" onClick={cancel}>{t("common.cancel")}</button>}
      {extra && <span className="git-cr-end">{extra}</span>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </form>;
}

/** A suggestion block: old against suggested lines, and Apply where the view is the working copy. */
function Suggestion({code, current, anchor, canApply, onApply}: {code: string; current: string | undefined; anchor: string | null; canApply: boolean; onApply(): Promise<void>}) {
  const t = useT();
  const state = suggestionState(code, current, anchor);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return <div className="git-code-review-suggestion">
    <pre className="git-code">{suggestionLines(current ?? anchor ?? "", code).map((line, index) =>
      <span key={index} className={line.kind === "add" ? "git-added" : line.kind === "del" ? "git-removed" : undefined}>
        {(line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ") + line.text + "\n"}</span>)}</pre>
    <div className="git-row">
      {state === "applied" ? <span className="g-muted">{t("cr.applied")}</span> : state === "outdated" ? <span className="g-muted">{t("cr.suggest-outdated")}</span>
        : canApply ? <button type="button" className="g-btn sm" disabled={pending} onClick={() => {
          setPending(true); setError("");
          onApply().catch(cause => setError(message(cause))).finally(() => setPending(false));
        }}>{pending ? t("cr.applying") : t("cr.apply")}</button> : <span className="g-muted">{t("cr.apply-where")}</span>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}

/** A comment's text and its suggestion blocks; the text is shown as written, never as HTML. */
function Body({comment, thread, current, canApply, api}: {comment: ReviewComment; thread: ReviewThread; current: string | undefined; canApply: boolean; api: CodeReviewApi}) {
  const Markdown = api.Markdown;
  return <>{bodyParts(comment.body).map((part, index) => part.kind === "text"
    ? Markdown ? <div key={index} className="git-review-body"><Markdown content={part.text.trim()}/></div> : <p key={index} className="git-review-body">{part.text.trim()}</p>
    : <Suggestion key={index} code={part.code} current={current} anchor={thread.anchorContent}
      canApply={canApply && thread.status === "open" && thread.side === "new"} onApply={() => api.apply(thread.id, comment.id)}/>)}</>;
}

/**
 * A comment thread: its comments, where it stands with the agent it was sent to, reply, resolve, dismiss and
 * reopen; the owner's comments can be edited and deleted. `current` is the commented lines' text now.
 */
export function ThreadCard({thread, api, current, canApply, showPath, outdated}: {
  thread: ReviewThread; api: CodeReviewApi; current: string | undefined; canApply: boolean; showPath?: boolean; outdated?: boolean;
}) {
  const t = useT();
  const kept = useKept();
  // A reply or an edit left unsent opens again with its text.
  const [replying, setReplying] = useState(() => kept.draft("reply:" + thread.id) !== undefined);
  const [editing, setEditing] = useState<string | null>(() => thread.comments.find(comment => kept.draft("edit:" + comment.id))?.id ?? null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(false);
  const act = (work: Promise<void>) => { setError(""); work.catch(cause => setError(message(cause))); };
  const closed = thread.status !== "open";
  // A closed thread starts folded; an open one always shows, also after it is reopened elsewhere.
  const open = !closed || shown;
  return <article className="git-review-thread git-cr-thread" data-thread-id={thread.id} tabIndex={-1} data-resolved={closed || undefined}
    data-severity={thread.severity ?? undefined} aria-label={t("cr.thread-on", {where: describeLocation(thread)})}>
    {(showPath || closed || outdated || thread.delivery) && <header className="git-cr-thread-head">
      {showPath && <span className="git-path">{describeLocation(thread)}</span>}
      {closed && <span className="g-chip line">{t(thread.status === "resolved" ? "cr.resolved" : "cr.dismissed")}</span>}
      {outdated && <span className="g-chip warn">{t("cr.outdated-chip")}</span>}
      {thread.delivery && <span className={"g-chip " + (thread.delivery.state === "answered" ? "good" : thread.delivery.state === "sent" ? "warn" : "line")}>
        {t(deliveryKey(thread.delivery.state))}</span>}
      {thread.delivery && (thread.delivery.threadId.startsWith("run:") ? <span className="g-muted">{t("cr.thread-starting")}</span>
        : <button type="button" className="g-btn ghost sm" onClick={() => api.openThread(thread.delivery!.threadId)}>{t("cr.open-the-thread")}</button>)}
      {closed && <button type="button" className="g-btn ghost sm git-cr-end" aria-expanded={open} onClick={() => setShown(value => !value)}>{t(open ? "cr.fold-thread" : "cr.show")}</button>}
    </header>}
    {open && <>
      {outdated && thread.anchorContent !== null && <pre className="git-code">{thread.anchorContent}</pre>}
      {thread.comments.map((comment, index) => <div key={comment.id} className="git-review-comment git-cr-comment">
        <div className="git-cr-comment-head"><strong>{comment.authorType === "user" ? t("cr.you") : comment.authorName}</strong>
          {index === 0 && thread.severity && <span className={"g-chip " + (thread.severity === "must-fix" ? "warn" : "line")} data-severity={thread.severity}>{t(severityKey(thread.severity))}</span>}
          {comment.editedAt !== null && <span className="g-muted">{t("cr.edited")}</span>}
        </div>
        {editing === comment.id
          ? <Composer label={t("cr.edit-comment")} initial={comment.body} submitLabel={t("cr.save")} onCancel={() => setEditing(null)} draftKey={"edit:" + comment.id}
            onSubmit={async body => { await api.editComment(comment.id, body); setEditing(null); }}/>
          : <Body comment={comment} thread={thread} current={current} canApply={canApply} api={api}/>}
        {comment.authorType === "user" && editing !== comment.id && <div className="git-cr-comment-actions">
          <button type="button" className="g-btn ghost sm" onClick={() => setEditing(comment.id)}>{t("cr.edit")}</button>
          <button type="button" className="g-btn ghost sm" onClick={() => act(api.deleteComment(comment.id))}>{t("rv.delete")}</button>
        </div>}
      </div>)}
      <div className="git-cr-thread-actions">
        {!closed && <button type="button" className="g-btn sm" aria-expanded={replying} onClick={() => setReplying(value => !value)}>{t("cr.reply")}</button>}
        {!closed && <button type="button" className="g-btn ghost sm" onClick={() => act(api.setStatus(thread.id, "resolved"))}>{t("cr.resolve")}</button>}
        {!closed && <button type="button" className="g-btn ghost sm" onClick={() => act(api.setStatus(thread.id, "dismissed"))}>{t("cr.dismiss")}</button>}
        {closed && <button type="button" className="g-btn ghost sm" onClick={() => act(api.setStatus(thread.id, "open"))}>{t("cr.reopen")}</button>}
      </div>
      {replying && <Composer label={t("cr.reply")} submitLabel={t("cr.reply")} onCancel={() => setReplying(false)} draftKey={"reply:" + thread.id}
        onSubmit={async body => { await api.addComment(thread.id, body); setReplying(false); }}/>}
    </>}
    {api.reviewerNote?.(thread.id) && <p className="git-warning" role="status">{api.reviewerNote(thread.id)}</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
  </article>;
}
