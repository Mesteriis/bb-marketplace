import { useMemo, useState } from "react";
import type { ReviewDiffFile } from "../../core/code-review/diff.ts";
import type { ReviewThread, Side } from "../../core/code-review/model.ts";
import { linesText, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { displayRows, type DisplayRow } from "../../core/code-review/rows.ts";
import type { CodeReviewApi, NewThread, Placement } from "./review-api.ts";
import { Composer, ThreadCard } from "./thread-card.tsx";

const sideOf = (row: DisplayRow): Side => row.kind === "deletion" ? "old" : "new";
const lineOf = (row: DisplayRow) => row.kind === "deletion" ? row.oldLine! : row.newLine!;
const keyOf = (side: Side, line: number) => side + ":" + line;

/**
 * One file of the review: its patch as rows with each thread under the last line it is placed on. Click a line
 * number to comment, Shift+click another line on the same side to comment on the range.
 */
export function FileDiff({file, threads, placements, wrap, workingCopy, api, onCreate}: {
  file: ReviewDiffFile; threads: ReviewThread[]; placements: Record<string, Placement>; wrap: boolean; workingCopy: boolean;
  api: CodeReviewApi; onCreate(thread: NewThread): Promise<void>;
}) {
  const rows = useMemo(() => file.patch ? displayRows(file.patch) : [], [file.patch]);
  const lines = useMemo(() => file.patch ? parsePatchLines(file.patch) : null, [file.patch]);
  const [selection, setSelection] = useState<{side: Side; from: number; to: number} | null>(null);
  const [fileComment, setFileComment] = useState(false);
  const [closed, setClosed] = useState(false);
  const below = new Map<string, ReviewThread[]>();
  const wholeFile: ReviewThread[] = [];
  for (const thread of threads) {
    const place = placements[thread.id];
    if (thread.startLine === 0 || thread.side === null) wholeFile.push(thread);
    else if (place && place.state !== "outdated") below.set(keyOf(thread.side, place.endLine), [...below.get(keyOf(thread.side, place.endLine)) ?? [], thread]);
  }
  const currentOf = (thread: ReviewThread) => {
    const place = placements[thread.id];
    return lines && thread.side && place && place.state !== "outdated" ? linesText(lines, thread.side, place.startLine, place.endLine) ?? undefined : undefined;
  };
  const pick = (row: DisplayRow, extend: boolean) => {
    const side = sideOf(row);
    const line = lineOf(row);
    setSelection(previous => extend && previous && previous.side === side ? {side, from: previous.from, to: line} : {side, from: line, to: line});
  };
  const range = selection ? {start: Math.min(selection.from, selection.to), end: Math.max(selection.from, selection.to)} : null;
  const selectedCode = selection && range && lines ? linesText(lines, selection.side, range.start, range.end) : null;
  const inSelection = (row: DisplayRow) => selection !== null && range !== null && row.kind !== "hunk" && sideOf(row) === selection.side
    && lineOf(row) >= range.start && lineOf(row) <= range.end;
  const additions = file.binary ? "binary" : "+" + file.additions + " −" + file.deletions;
  return <section className="git-review-file" aria-label={file.path}>
    <header className="git-row git-review-file-head">
      <button type="button" className="git-link" aria-expanded={!closed} onClick={() => setClosed(value => !value)}>{closed ? "▸" : "▾"}</button>
      <strong className="git-path">{file.previousPath ? file.previousPath + " → " : ""}{file.path}</strong>
      <span className="git-muted">{file.untracked ? "untracked" : file.changeKind.replace("_", " ")} · {additions}</span>
      {threads.length > 0 && <span className="git-review-tag">{threads.filter(thread => thread.status === "open").length} open</span>}
      <span className="git-ci-spacer"/>
      <button type="button" aria-expanded={fileComment} onClick={() => setFileComment(value => !value)}>Comment on file</button>
    </header>
    {!closed && <>
      {fileComment && <Composer label={"Comment on " + file.path} withSeverity submitLabel="Comment" onCancel={() => setFileComment(false)}
        onSubmit={async (body, severity) => { await onCreate({filePath: file.path, side: null, startLine: 0, endLine: 0, anchorContent: null, severity, body}); setFileComment(false); }}/>}
      {wholeFile.map(thread => <ThreadCard key={thread.id} thread={thread} api={api} current={undefined} canApply={false}/>)}
      {!file.patch ? <p className="git-muted">{file.binary ? "Binary file: no line diff." : "This file's diff is too large to show."}</p> :
        <div className="git-review-diff" data-wrap={wrap || undefined} role="group" aria-label={"Diff of " + file.path}>
          {rows.map((row, index) => <div key={index}>
            <div className="git-review-row" data-kind={row.kind === "addition" ? "add" : row.kind === "deletion" ? "del" : row.kind === "hunk" ? "hunk" : "ctx"}
              data-selected={inSelection(row) || undefined}>
              {row.kind === "hunk" ? <span className="git-review-hunk">{row.text}</span> : <>
                <button type="button" className="git-review-number" aria-label={row.kind === "deletion" ? "Comment on old line " + row.oldLine : "Comment on line " + row.newLine}
                  onClick={event => pick(row, event.shiftKey)}>{row.oldLine ?? ""}</button>
                <button type="button" className="git-review-number" tabIndex={-1} aria-hidden="true" onClick={event => pick(row, event.shiftKey)}>{row.newLine ?? ""}</button>
                <code className="git-review-code">{row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}{row.text}</code>
              </>}
            </div>
            {row.kind !== "hunk" && below.get(keyOf(sideOf(row), lineOf(row)))?.map(thread =>
              <ThreadCard key={thread.id} thread={thread} api={api} current={currentOf(thread)} canApply={workingCopy}/>)}
            {selection && range && row.kind !== "hunk" && sideOf(row) === selection.side && lineOf(row) === range.end && <div className="git-code-review-new">
              <p className="git-muted">{"Comment on " + (range.start === range.end ? "line " + range.end : "lines " + range.start + "–" + range.end) + (selection.side === "old" ? " (removed)" : "")}</p>
              <Composer label="Line comment" withSeverity code={selection.side === "new" ? selectedCode : null} submitLabel="Comment" onCancel={() => setSelection(null)}
                onSubmit={async (body, severity) => {
                  await onCreate({filePath: file.path, side: selection.side, startLine: range.start, endLine: range.end, anchorContent: selectedCode, severity, body});
                  setSelection(null);
                }}/>
            </div>}
          </div>)}
        </div>}
    </>}
  </section>;
}
