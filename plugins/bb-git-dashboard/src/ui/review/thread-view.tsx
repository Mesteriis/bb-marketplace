import { useState } from "react";
import type { PrAction } from "../../core/pulls/actions.ts";
import type { PrDetailView } from "./review-api.ts";

type Thread = PrDetailView["threads"][number];

/** One review thread: its comments as plain text, a reply box, resolve, and Fix with agent. */
export function ThreadView({thread, can, act, ask, showPath = true}: {
  thread: Thread; can: {reply: boolean; resolve: boolean}; act(action: PrAction): void; ask(): void; showPath?: boolean;
}) {
  const [reply, setReply] = useState("");
  // A comment of an unsubmitted review exists only for its author until submitted on the forge.
  const live = !thread.isPending;
  const where = thread.line === null ? "" : thread.startLine ? " lines " + thread.startLine + "–" + thread.line : " line " + thread.line;
  return <article className="git-review-thread" data-resolved={thread.isResolved || undefined}>
    <header className="git-row">
      {showPath && <strong className="git-path">{thread.path}{where}{thread.side === "LEFT" ? " (old)" : ""}</strong>}
      {thread.isOutdated && <span className="git-review-tag">Outdated</span>}
      {thread.isResolved && <span className="git-review-tag">Resolved{thread.resolvedBy ? " by " + thread.resolvedBy : ""}</span>}
      {!thread.isResolved && thread.awaitingReply && <span className="git-review-tag" data-waiting>Waiting for the author</span>}
      {thread.isPending && <span className="git-review-tag">Pending review</span>}
    </header>
    {thread.comments.map((comment, index) => <div key={comment.id || index} className="git-review-comment">
      <div className="git-muted">{comment.author} · {comment.createdAt.slice(0, 16).replace("T", " ")}</div>
      <p className="git-review-body">{comment.body}</p>
    </div>)}
    <form className="git-row git-review-reply" onSubmit={event => { event.preventDefault(); if (reply.trim()) act({kind: "reply", threadId: thread.id, body: reply}); }}>
      {live && can.reply && <input aria-label={"Reply in " + thread.path} placeholder="Reply" value={reply} onChange={event => setReply(event.target.value)}/>}
      {live && can.reply && <button type="submit" disabled={!reply.trim()}>Reply</button>}
      {live && can.resolve && thread.canToggleResolved && <button type="button" onClick={() => act({kind: "resolve", threadId: thread.id, resolved: !thread.isResolved})}>
        {thread.isResolved ? "Unresolve" : "Resolve"}</button>}
      {live && !thread.isResolved && <button type="button" onClick={ask}>Fix with agent</button>}
    </form>
  </article>;
}
