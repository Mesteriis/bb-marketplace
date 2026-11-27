import { useMemo, useState } from "react";
import type { ReviewDiffFile } from "../../core/code-review/diff.ts";
import type { ReviewThread, Side } from "../../core/code-review/model.ts";
import { linesText, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { displayRows, splitRows, type DisplayRow } from "../../core/code-review/rows.ts";
import type { ExplainPlace } from "../../core/code-review/run-prompts.ts";
import type { CodeReviewApi, NewThread, Placement } from "./review-api.ts";
import { Composer, ThreadCard } from "./thread-card.tsx";

const sideOf = (row: DisplayRow): Side => row.kind === "deletion" ? "old" : "new";
const lineOf = (row: DisplayRow) => row.kind === "deletion" ? row.oldLine! : row.newLine!;
const keyOf = (side: Side, line: number) => side + ":" + line;
const kindOf = (row: DisplayRow) => row.kind === "addition" ? "add" : row.kind === "deletion" ? "del" : "ctx";
/** What the diff lays out: unified rows, or old and new side by side. */
type Item = {kind: "hunk"; text: string} | {kind: "single"; row: DisplayRow} | {kind: "pair"; old: DisplayRow | null; new: DisplayRow | null};
/** The lines a laid-out row stands for: threads and the composer go under the row of their last line. */
function anchorsOf(item: Item): {side: Side; line: number}[] {
  if (item.kind === "hunk") return [];
  if (item.kind === "single") return [{side: sideOf(item.row), line: lineOf(item.row)}];
  // A context line is one line on both sides: its threads are on the new side, or the old where they were made.
  return [...item.old ? [{side: "old" as const, line: item.old.oldLine!}] : [], ...item.new ? [{side: "new" as const, line: item.new.newLine!}] : []];
}

/**
 * One file of the review: its patch as rows with each thread under the last line it is placed on. Click a line
 * number to comment, Shift+click another line on the same side to comment on the range.
 */
export function FileDiff({file, threads, placements, wrap, split, workingCopy, api, onCreate, onExplain, explaining}: {
  file: ReviewDiffFile; threads: ReviewThread[]; placements: Record<string, Placement>; wrap: boolean; split: boolean; workingCopy: boolean;
  api: CodeReviewApi; onCreate(thread: NewThread): Promise<void>;
  /** Starts an AI run that explains the file or the selected lines. */
  onExplain(place: ExplainPlace): Promise<void>; explaining: boolean;
}) {
  const rows = useMemo(() => file.patch ? displayRows(file.patch) : [], [file.patch]);
  const items: Item[] = useMemo(() => split ? splitRows(rows)
    : rows.map(row => row.kind === "hunk" ? {kind: "hunk" as const, text: row.text} : {kind: "single" as const, row}), [rows, split]);
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
  const pickAt = (side: Side, line: number, extend: boolean) =>
    setSelection(previous => extend && previous && previous.side === side ? {side, from: previous.from, to: line} : {side, from: line, to: line});
  const pick = (row: DisplayRow, extend: boolean) => pickAt(sideOf(row), lineOf(row), extend);
  const range = selection ? {start: Math.min(selection.from, selection.to), end: Math.max(selection.from, selection.to)} : null;
  const selectedCode = selection && range && lines ? linesText(lines, selection.side, range.start, range.end) : null;
  const inSide = (side: Side, line: number) => selection !== null && range !== null && side === selection.side && line >= range.start && line <= range.end;
  const inSelection = (row: DisplayRow) => row.kind !== "hunk" && inSide(sideOf(row), lineOf(row));
  const additions = file.binary ? "binary" : "+" + file.additions + " −" + file.deletions;
  return <section className="git-review-file" aria-label={file.path}>
    <header className="git-row git-review-file-head">
      <button type="button" className="git-link" aria-expanded={!closed} onClick={() => setClosed(value => !value)}>{closed ? "▸" : "▾"}</button>
      <strong className="git-path">{file.previousPath ? file.previousPath + " → " : ""}{file.path}</strong>
      <span className="git-muted">{file.untracked ? "untracked" : file.changeKind.replace("_", " ")} · {additions}</span>
      {threads.length > 0 && <span className="git-review-tag">{threads.filter(thread => thread.status === "open").length} open</span>}
      <span className="git-ci-spacer"/>
      <button type="button" disabled={explaining} onClick={() => void onExplain({filePath: file.path, side: null, startLine: 0, endLine: 0, code: null})}>Explain</button>
      <button type="button" aria-expanded={fileComment} onClick={() => setFileComment(value => !value)}>Comment on file</button>
    </header>
    {!closed && <>
      {fileComment && <Composer label={"Comment on " + file.path} withSeverity submitLabel="Comment" onCancel={() => setFileComment(false)}
        onSubmit={async (body, severity) => { await onCreate({filePath: file.path, side: null, startLine: 0, endLine: 0, anchorContent: null, severity, body}); setFileComment(false); }}/>}
      {wholeFile.map(thread => <ThreadCard key={thread.id} thread={thread} api={api} current={undefined} canApply={false}/>)}
      {!file.patch ? <p className="git-muted">{file.binary ? "Binary file: no line diff." : "This file's diff is too large to show."}</p> :
        <div className="git-review-diff" data-wrap={wrap || undefined} role="group" aria-label={"Diff of " + file.path}>
          {items.map((item, index) => <div key={index}>
            {item.kind === "hunk" ? <div className="git-review-row" data-kind="hunk"><span className="git-review-hunk">{item.text}</span></div>
              : item.kind === "single" ? <div className="git-review-row" data-kind={kindOf(item.row)} data-selected={inSelection(item.row) || undefined}>
                <button type="button" className="git-review-number" aria-label={item.row.kind === "deletion" ? "Comment on old line " + item.row.oldLine : "Comment on line " + item.row.newLine}
                  onClick={event => pick(item.row, event.shiftKey)}>{item.row.oldLine ?? ""}</button>
                <button type="button" className="git-review-number" tabIndex={-1} aria-hidden="true" onClick={event => pick(item.row, event.shiftKey)}>{item.row.newLine ?? ""}</button>
                <code className="git-review-code">{item.row.kind === "addition" ? "+" : item.row.kind === "deletion" ? "−" : " "}{item.row.text}</code>
              </div>
              : <div className="git-review-split">{(["old", "new"] as const).map(side => {
                const row = item[side];
                const line = row ? (side === "old" ? row.oldLine : row.newLine) : null;
                const kind = !row ? "none" : row.kind === "context" ? "ctx" : side === "old" ? "del" : "add";
                return <div key={side} className="git-review-row" data-kind={kind} data-selected={row && line !== null && inSide(side, line) || undefined}>
                  {row && line !== null ? <>
                    <button type="button" className="git-review-number" aria-label={(side === "old" ? "Comment on old line " : "Comment on line ") + line} onClick={event => pickAt(side, line, event.shiftKey)}>{line}</button>
                    <code className="git-review-code">{kind === "add" ? "+" : kind === "del" ? "−" : " "}{row.text}</code>
                  </> : null}
                </div>;
              })}</div>}
            {anchorsOf(item).flatMap(anchor => below.get(keyOf(anchor.side, anchor.line)) ?? []).map(thread =>
              <ThreadCard key={thread.id} thread={thread} api={api} current={currentOf(thread)} canApply={workingCopy}/>)}
            {selection && range && anchorsOf(item).some(anchor => anchor.side === selection.side && anchor.line === range.end) && <div className="git-code-review-new">
              <div className="git-row">
                <p className="git-muted">{"Comment on " + (range.start === range.end ? "line " + range.end : "lines " + range.start + "–" + range.end) + (selection.side === "old" ? " (removed)" : "")}</p>
                <span className="git-ci-spacer"/>
                <button type="button" disabled={explaining} onClick={() => { void onExplain({filePath: file.path, side: selection.side, startLine: range.start, endLine: range.end, code: selectedCode}); setSelection(null); }}>
                  Explain {range.start === range.end ? "this line" : "these lines"}</button>
              </div>
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
