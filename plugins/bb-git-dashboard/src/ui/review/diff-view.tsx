import { useMemo, useState } from "react";
import type { PrAction } from "../../core/pulls/actions.ts";
import { lineAnchor, parsePatch, type DiffLine } from "../../core/pulls/diff.ts";
import type { PrDetailView, PrFileView } from "./review-api.ts";
import { ThreadView } from "./thread-view.tsx";

type Thread = PrDetailView["threads"][number];
export type DraftComment = {path: string; oldPath: string | null; line: number; side: "LEFT" | "RIGHT"; startLine: number | null; contextLine: number | null; body: string};

const rowKey = (row: DiffLine) => row.kind === "del" ? "L" + row.oldLine : "R" + row.newLine;
const threadKey = (thread: Thread) => (thread.side === "LEFT" ? "L" : "R") + thread.line;

/**
 * A file's patch as rows with the threads under their lines. Click a line number to comment, Shift-click to extend
 * the selection; the comment is posted at once or added to the pending review.
 */
export function FileDiff({file, threads, wrap, canComment, act, ask, onDraft, can}: {
  file: PrFileView; threads: Thread[]; wrap: boolean; canComment: boolean; act(action: PrAction): void; ask(thread: Thread): void;
  onDraft(comment: DraftComment): void; can: {reply: boolean; resolve: boolean};
}) {
  const rows = useMemo(() => file.patch ? parsePatch(file.patch) : [], [file.patch]);
  const [selection, setSelection] = useState<{from: number; to: number} | null>(null);
  const [body, setBody] = useState("");
  const byLine = new Map<string, Thread[]>();
  for (const thread of threads) if (thread.line !== null && !thread.isOutdated) byLine.set(threadKey(thread), [...byLine.get(threadKey(thread)) ?? [], thread]);
  const keyOf = (thread: Thread) => thread.id + ":" + thread.comments.length;
  const loose = threads.filter(thread => thread.line === null || thread.isOutdated || !rows.some(row => row.kind !== "hunk" && rowKey(row) === threadKey(thread)));
  const anchor = selection ? lineAnchor(rows, selection.from, selection.to) : null;
  const pick = (index: number, extend: boolean) => {
    if (!canComment || rows[index]?.kind === "hunk") return;
    setSelection(previous => extend && previous ? {from: previous.from, to: index} : {from: index, to: index});
  };
  const comment = (now: boolean) => {
    if (!anchor || !body.trim()) return;
    const value = {path: file.path, oldPath: file.previousPath, ...anchor, body};
    // A comment sent now stays in the box until the page reloads after confirmation, so cancelling keeps it.
    if (now) { act({kind: "lineComment", ...value}); return; }
    onDraft(value);
    setSelection(null); setBody("");
  };
  const selected = (index: number) => selection !== null && index >= Math.min(selection.from, selection.to) && index <= Math.max(selection.from, selection.to);
  return <section className="git-review-file" aria-label={file.path}>
    <header className="git-row git-review-file-head">
      <strong className="git-path">{file.previousPath ? file.previousPath + " → " : ""}{file.path}</strong>
      <span className="git-muted">{file.status}</span>
      <span className="git-inbox-plus">+{file.additions}</span><span className="git-inbox-minus">−{file.deletions}</span>
    </header>
    {loose.map(thread => <ThreadView key={keyOf(thread)} thread={thread} can={can} act={act} ask={() => ask(thread)}/>)}
    {!file.patch ? <p className="git-muted">No line diff for this file (binary, too large, or not provided by the forge).</p> :
      <div className="git-review-diff" data-wrap={wrap || undefined} role="group" aria-label={"Diff of " + file.path}>
        {rows.map((row, index) => <div key={index}>
          <div className="git-review-row" data-kind={row.kind} data-selected={selected(index) || undefined}>
            {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
              <button type="button" className="git-review-number" disabled={!canComment} aria-label={row.kind === "del" ? "Comment on old line " + row.oldLine : "Comment on line " + row.newLine}
                onClick={event => pick(index, event.shiftKey)}>{row.oldLine ?? ""}</button>
              <button type="button" className="git-review-number" disabled={!canComment} tabIndex={-1} aria-hidden="true"
                onClick={event => pick(index, event.shiftKey)}>{row.newLine ?? ""}</button>
              <code className="git-review-code">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}{row.text}</code>
            </>}
          </div>
          {row.kind !== "hunk" && byLine.get(rowKey(row))?.map(thread =>
            <ThreadView key={keyOf(thread)} thread={thread} can={can} act={act} ask={() => ask(thread)} showPath={false}/>)}
          {selection && index === Math.max(selection.from, selection.to) && <form className="git-review-composer"
            onSubmit={event => { event.preventDefault(); comment(true); }}>
            <p className="git-muted">{anchor ? "Comment on " + (anchor.startLine ? "lines " + anchor.startLine + "–" + anchor.line : "line " + anchor.line) +
              (anchor.side === "LEFT" ? " (old)" : "") : "A comment cannot span two hunks."}</p>
            <textarea aria-label="Line comment" value={body} onChange={event => setBody(event.target.value)} rows={3}/>
            <div className="git-row">
              <button type="submit" className="git-primary" disabled={!anchor || !body.trim()}>Comment</button>
              <button type="button" disabled={!anchor || !body.trim()} onClick={() => comment(false)}>Add to review</button>
              <button type="button" onClick={() => { setSelection(null); setBody(""); }}>Cancel</button>
            </div>
          </form>}
        </div>)}
      </div>}
  </section>;
}
