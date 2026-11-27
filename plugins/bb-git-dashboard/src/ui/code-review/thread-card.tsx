import { useState, type KeyboardEvent } from "react";
import { SEVERITY_OPTIONS } from "./severity.ts";
import { describeLocation, type ReviewComment, type ReviewThread, type Severity } from "../../core/code-review/model.ts";
import { bodyParts, insertSuggestion, suggestionLines, suggestionState } from "../../core/code-review/suggestion.ts";
import { deliveryLabel, message, severityLabel, type CodeReviewApi } from "./review-api.ts";

/**
 * A comment box: ⌘/Ctrl+Enter sends, Escape cancels; "Suggest a change" adds a suggestion block seeded with the
 * commented lines. `severity` is offered on a new thread only.
 */
export function Composer({label, initial = "", code, withSeverity, submitLabel, onSubmit, onCancel}: {
  label: string; initial?: string; code?: string | null; withSeverity?: boolean; submitLabel: string;
  onSubmit(body: string, severity: Severity | null): Promise<void>; onCancel?(): void;
}) {
  const [body, setBody] = useState(initial);
  const [severity, setSeverity] = useState<Severity | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!body.trim() || pending) return;
    setPending(true); setError("");
    try { await onSubmit(body, severity || null); setBody(""); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); }
  };
  return <form className="git-review-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <textarea aria-label={label} value={body} rows={3} autoFocus onChange={event => setBody(event.target.value)} onKeyDown={keys}/>
    <div className="git-row git-code-review-composer-bar">
      {withSeverity && <select aria-label="Severity" value={severity} onChange={event => setSeverity(event.target.value as Severity | "")}>
        <option value="">No severity</option>
        {SEVERITY_OPTIONS.map(value => <option key={value} value={value}>{severityLabel[value]}</option>)}
      </select>}
      {code !== undefined && code !== null && <button type="button" onClick={() => setBody(current => insertSuggestion(current, current.length, code).body)}>Suggest a change</button>}
      <span className="git-ci-spacer"/>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="git-primary" disabled={pending || !body.trim()}>{pending ? "Saving…" : submitLabel}</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </form>;
}

/** A suggestion block: old against suggested lines, and Apply where the view is the working copy. */
function Suggestion({code, current, anchor, canApply, onApply}: {code: string; current: string | undefined; anchor: string | null; canApply: boolean; onApply(): Promise<void>}) {
  const state = suggestionState(code, current, anchor);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return <div className="git-code-review-suggestion">
    <pre className="git-code">{suggestionLines(current ?? anchor ?? "", code).map((line, index) =>
      <span key={index} className={line.kind === "add" ? "git-added" : line.kind === "del" ? "git-removed" : undefined}>
        {(line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ") + line.text + "\n"}</span>)}</pre>
    <div className="git-row">
      {state === "applied" ? <span className="git-muted">Applied</span> : state === "outdated" ? <span className="git-muted">The lines changed since this was suggested.</span>
        : canApply ? <button type="button" disabled={pending} onClick={() => {
          setPending(true); setError("");
          onApply().catch(cause => setError(message(cause))).finally(() => setPending(false));
        }}>{pending ? "Applying…" : "Apply suggestion"}</button> : <span className="git-muted">Suggestions apply in the uncommitted, unstaged or all-changes view.</span>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}

/** A comment's text and its suggestion blocks; the text is shown as written, never as HTML. */
function Body({comment, thread, current, canApply, api}: {comment: ReviewComment; thread: ReviewThread; current: string | undefined; canApply: boolean; api: CodeReviewApi}) {
  return <>{bodyParts(comment.body).map((part, index) => part.kind === "text"
    ? <p key={index} className="git-review-body">{part.text.trim()}</p>
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
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(thread.status === "open");
  const act = (work: Promise<void>) => { setError(""); work.catch(cause => setError(message(cause))); };
  const closed = thread.status !== "open";
  return <article className="git-review-thread" data-resolved={closed || undefined} aria-label={"Comment thread on " + describeLocation(thread)}>
    <header className="git-row git-code-review-thread-head">
      {showPath && <span className="git-path">{describeLocation(thread)}</span>}
      {thread.severity && <span className="git-review-tag" data-severity={thread.severity}>{severityLabel[thread.severity]}</span>}
      {closed && <span className="git-review-tag">{thread.status === "resolved" ? "Resolved" : "Dismissed"}</span>}
      {outdated && <span className="git-review-tag" data-waiting>Outdated</span>}
      {thread.delivery && <span className="git-review-tag" data-waiting={thread.delivery.state === "sent" || undefined}>
        {deliveryLabel[thread.delivery.state]}{" "}<button type="button" className="git-link" onClick={() => api.openThread(thread.delivery!.threadId)}>Open the thread</button></span>}
      <span className="git-ci-spacer"/>
      {closed && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Fold" : "Show"}</button>}
    </header>
    {open && <>
      {outdated && thread.anchorContent !== null && <pre className="git-code">{thread.anchorContent}</pre>}
      {thread.comments.map(comment => <div key={comment.id} className="git-review-comment">
        <div className="git-row"><strong>{comment.authorType === "user" ? "You" : comment.authorName}</strong>
          {comment.editedAt !== null && <span className="git-muted">edited</span>}
          <span className="git-ci-spacer"/>
          {comment.authorType === "user" && editing !== comment.id && <>
            <button type="button" onClick={() => setEditing(comment.id)}>Edit</button>
            <button type="button" onClick={() => act(api.deleteComment(comment.id))}>Delete</button>
          </>}
        </div>
        {editing === comment.id
          ? <Composer label="Edit comment" initial={comment.body} submitLabel="Save" onCancel={() => setEditing(null)}
            onSubmit={async body => { await api.editComment(comment.id, body); setEditing(null); }}/>
          : <Body comment={comment} thread={thread} current={current} canApply={canApply} api={api}/>}
      </div>)}
      <div className="git-row git-review-actions">
        {!closed && <button type="button" aria-expanded={replying} onClick={() => setReplying(value => !value)}>Reply</button>}
        {!closed && <button type="button" onClick={() => act(api.setStatus(thread.id, "resolved"))}>Resolve</button>}
        {!closed && <button type="button" onClick={() => act(api.setStatus(thread.id, "dismissed"))}>Dismiss</button>}
        {closed && <button type="button" onClick={() => act(api.setStatus(thread.id, "open"))}>Reopen</button>}
      </div>
      {replying && <Composer label="Reply" submitLabel="Reply" onCancel={() => setReplying(false)}
        onSubmit={async body => { await api.addComment(thread.id, body); setReplying(false); }}/>}
    </>}
    {error && <p className="git-error" role="alert">{error}</p>}
  </article>;
}
