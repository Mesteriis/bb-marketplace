import { useMemo, useRef, useState } from "react";
import { LARGE_CHANGE } from "../code-review/file-diff.tsx";
import type { PrAction } from "../../core/pulls/actions.ts";
import { lineAnchor, parsePatch, splitIndexes, type DiffLine } from "../../core/pulls/diff.ts";
import { CodeText, useHighlight, useNear } from "../highlight/use-highlight.tsx";
import type { PrDetailView, PrFileView } from "./review-api.ts";
import { ThreadView } from "./thread-view.tsx";

type Thread = PrDetailView["threads"][number];
export type DraftComment = {path: string; oldPath: string | null; line: number; side: "LEFT" | "RIGHT"; startLine: number | null; contextLine: number | null; body: string};

const rowKey = (row: DiffLine) => row.kind === "del" ? "L" + row.oldLine : "R" + row.newLine;
const threadKey = (thread: Thread) => (thread.side === "LEFT" ? "L" : "R") + thread.line;

/**
 * A file's patch as rows, unified or side by side, with the threads under their lines. Click a line number to comment,
 * Shift-click to extend the selection; the comment is posted at once or added to the pending review.
 */
export function FileDiff({file, threads, wrap, split = false, canComment, act, ask, onDraft, can, people}: {
  file: PrFileView; threads: Thread[]; wrap: boolean; split?: boolean; canComment: boolean; act(action: PrAction): void; ask(thread: Thread): void;
  onDraft(comment: DraftComment): void; can: {reply: boolean; resolve: boolean; delete?: boolean}; people?: {viewer: string; author: string};
}) {
  const rows = useMemo(() => file.patch ? parsePatch(file.patch) : [], [file.patch]);
  const pairs = useMemo(() => split ? splitIndexes(rows) : null, [rows, split]);
  // Painted once near the viewport, and not at all over LARGE_CHANGE lines, as Review folds them.
  const section = useRef<HTMLElement>(null);
  const near = useNear(section);
  const tokensOf = useHighlight(file.path, rows, near && file.additions + file.deletions <= LARGE_CHANGE);
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
  const sign = (row: DiffLine) => row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const number = (index: number, line: number | null, label: string, hidden = false) => <button type="button" className="git-review-number" disabled={!canComment}
    {...(hidden ? {tabIndex: -1, "aria-hidden": true} : {"aria-label": label})} onClick={event => pick(index, event.shiftKey)}>{line ?? ""}</button>;
  const label = (row: DiffLine) => row.kind === "del" ? "Comment on old line " + row.oldLine : "Comment on line " + row.newLine;
  const below = (indexes: number[]) => indexes.flatMap(index => rows[index]?.kind === "hunk" ? [] : byLine.get(rowKey(rows[index]!)) ?? [])
    .map(thread => <ThreadView key={keyOf(thread)} thread={thread} can={can} act={act} ask={() => ask(thread)} showPath={false} people={people}/>);
  const composer = (indexes: number[]) => selection && indexes.includes(Math.max(selection.from, selection.to)) && <form className="git-review-composer"
    onSubmit={event => { event.preventDefault(); comment(true); }}>
    <p className="git-muted">{anchor ? "Comment on " + (anchor.startLine ? "lines " + anchor.startLine + "–" + anchor.line : "line " + anchor.line) +
      (anchor.side === "LEFT" ? " (old)" : "") : "A comment cannot span two hunks."}</p>
    <textarea aria-label="Line comment" value={body} onChange={event => setBody(event.target.value)} rows={3}/>
    <div className="git-row">
      <button type="submit" className="git-primary" disabled={!anchor || !body.trim()}>Comment</button>
      <button type="button" disabled={!anchor || !body.trim()} onClick={() => comment(false)}>Add to review</button>
      <button type="button" onClick={() => { setSelection(null); setBody(""); }}>Cancel</button>
    </div>
  </form>;
  const open = threads.filter(thread => !thread.isResolved).length;
  return <section ref={section} className="git-review-file" aria-label={file.path} data-path={file.path} tabIndex={-1}>
    <header className="git-row git-review-file-head">
      <strong className="git-path">{file.previousPath ? file.previousPath + " → " : ""}{file.path}</strong>
      <span className="git-muted">{file.status}</span>
      <span className="git-inbox-plus">+{file.additions}</span><span className="git-inbox-minus">−{file.deletions}</span>
      {open > 0 && <span className="git-review-tag">{open} open</span>}
    </header>
    {loose.map(thread => <ThreadView key={keyOf(thread)} thread={thread} can={can} act={act} ask={() => ask(thread)} people={people}/>)}
    {!file.patch ? <p className="git-muted">No line diff for this file (binary, too large, or not provided by the forge).</p> :
      <div className="git-review-diff" data-wrap={wrap || undefined} role="group" aria-label={"Diff of " + file.path}>
        {pairs ? pairs.map((pair, index) => {
          if (pair.kind === "hunk") return <div key={index} className="git-review-row" data-kind="hunk"><span className="git-review-hunk">{rows[pair.index]!.text}</span></div>;
          const indexes = [...new Set([pair.old, pair.new].filter((value): value is number => value !== null))];
          return <div key={index}>
            <div className="git-review-split">{(["old", "new"] as const).map(side => {
              const at = pair[side];
              const row = at === null ? null : rows[at]!;
              const kind = !row ? "none" : row.kind === "ctx" ? "ctx" : row.kind;
              return <div key={side} className="git-review-row" data-kind={kind} data-selected={at !== null && selected(at) || undefined}>
                {row && at !== null ? <>
                  {number(at, side === "old" ? row.oldLine : row.newLine, side === "old" ? "Comment on old line " + row.oldLine : "Comment on line " + row.newLine,
                    side === "old" && row.kind === "ctx")}
                  <code className="git-review-code">{sign(row)}<CodeText text={row.text} tokens={tokensOf(at, side)}/></code>
                </> : null}
              </div>;
            })}</div>
            {below(indexes)}
            {composer(indexes)}
          </div>;
        }) : rows.map((row, index) => <div key={index}>
          <div className="git-review-row" data-kind={row.kind} data-selected={selected(index) || undefined}>
            {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
              {number(index, row.oldLine, label(row))}
              {number(index, row.newLine, "", true)}
              <code className="git-review-code">{sign(row)}<CodeText text={row.text} tokens={tokensOf(index)}/></code>
            </>}
          </div>
          {row.kind !== "hunk" && below([index])}
          {composer([index])}
        </div>)}
      </div>}
  </section>;
}
