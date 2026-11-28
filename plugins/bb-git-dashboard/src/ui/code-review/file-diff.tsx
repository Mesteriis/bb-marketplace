import { useEffect, useMemo, useRef, useState } from "react";
import { changeRevision, type ReviewDiffFile } from "../../core/code-review/diff.ts";
import type { ReviewThread, Side } from "../../core/code-review/model.ts";
import { linesText, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { displayRows, splitRows, type DisplayRow } from "../../core/code-review/rows.ts";
import type { ExplainPlace } from "../../core/code-review/run-prompts.ts";
import type { CodeReviewApi, NewThread, Placement } from "./review-api.ts";
import { Composer, ThreadCard } from "./thread-card.tsx";
import { useKept } from "./kept-state.tsx";
import { RevertForm } from "./revert-form.tsx";
import { CodeText, useHighlight, useNear } from "../highlight/use-highlight.tsx";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";

const sideOf = (row: DisplayRow): Side => row.kind === "deletion" ? "old" : "new";
const lineOf = (row: DisplayRow) => row.kind === "deletion" ? row.oldLine! : row.newLine!;
const keyOf = (side: Side, line: number) => side + ":" + line;
export const LARGE_CHANGE = 2_000;
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
export function FileDiff({file, threads, placements, wrap, split, workingCopy, api, onCreate, onExplain, explaining, patchError, onRetryPatch, onOpen,
  found, current, reveal, onRevert, hunksPickable}: {
  file: ReviewDiffFile; threads: ReviewThread[]; placements: Record<string, Placement>; wrap: boolean; split: boolean; workingCopy: boolean;
  /** Why the deferred patch could not be read; Retry reads the batches again. */
  patchError: string; onRetryPatch(): void;
  /** Opens the working copy's file at a line in BB's preview; absent for a deleted file. */
  onOpen?(line: number | null): void;
  /** Rows (indices into the file's rows) Find matched, and the one it is on. */
  found?: ReadonlySet<number>; current?: number | null;
  /** Changes when something in this file is to be shown: the file unfolds. */
  reveal?: number;
  /** Reverts the file (`hunks` null) or some hunks to HEAD; absent where the view cannot revert. */
  onRevert?(revision: string, hunks: number[] | null): Promise<void>;
  /** Whether hunks can be picked: not with whitespace hidden, whose hunks are not git's. */
  hunksPickable?: boolean;
  api: CodeReviewApi; onCreate(thread: NewThread): Promise<void>;
  /** Starts an AI run that explains the file or the selected lines. */
  onExplain(place: ExplainPlace): Promise<void>; explaining: boolean;
}) {
  const t = useT();
  const rows = useMemo(() => file.patch ? displayRows(file.patch) : [], [file.patch]);
  const items: Item[] = useMemo(() => split ? splitRows(rows)
    : rows.map(row => row.kind === "hunk" ? {kind: "hunk" as const, text: row.text} : {kind: "single" as const, row}), [rows, split]);
  const lines = useMemo(() => file.patch ? parsePatchLines(file.patch) : null, [file.patch]);
  const kept = useKept();
  // An unsent line comment comes back with its lines selected; one on the file, opened.
  const [selection, setSelection] = useState<{side: Side; from: number; to: number} | null>(() => {
    const range = kept.draft("line:" + file.path)?.range;
    return range ? {side: range.side, from: range.start, to: range.end} : null;
  });
  const [fileComment, setFileComment] = useState(() => kept.draft("file:" + file.path) !== undefined);
  // A change of more than LARGE_CHANGE lines starts folded: it is slow to show and rarely read line by line.
  const large = file.additions + file.deletions > LARGE_CHANGE;
  const [closed, setClosedState] = useState(() => kept.fold(file.path) ?? (large || file.viewed === true));
  const setClosed = setClosedState;
  const toggleFold = () => setClosedState(current => { kept.setFold(file.path, !current); return !current; });
  // Marking a file Viewed folds it; a mark that went stale (its change moved on) unfolds it.
  const lastViewed = useRef(file.viewed);
  useEffect(() => {
    // Only a change of the mark folds or unfolds; on mount the kept fold stands.
    if (file.viewed === undefined || file.viewed === lastViewed.current) return;
    lastViewed.current = file.viewed;
    setClosed(file.viewed || large);
  }, [file.viewed, large]);
  // Painted only while unfolded and read: a folded or deferred file costs nothing.
  const section = useRef<HTMLElement>(null);
  const near = useNear(section);
  const tokensOf = useHighlight(file.path, rows, near && !closed && !file.deferred);
  const [reverting, setReverting] = useState(false);
  useEffect(() => { if (reveal) setClosed(false); }, [reveal]);
  const indexOf = useMemo(() => new Map(rows.map((row, index) => [row, index])), [rows]);
  const mark = (row: DisplayRow | null) => {
    const index = row ? indexOf.get(row) : undefined;
    return index === undefined ? {} : {"data-row": index, "data-found": found?.has(index) || undefined, "data-current": current === index || undefined};
  };
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
  const open = threads.filter(thread => thread.status === "open").length;
  const what = file.whole ? t("cr.whole-file", {n: rows.filter(row => row.kind !== "hunk").length})
    : file.untracked ? t("cr.untracked") : t(("cr.change." + file.changeKind) as MessageKey);
  return <section ref={section} className="git-review-file" aria-label={file.path} data-path={file.path} tabIndex={-1}>
    <header className="git-cr-file-head">
      <button type="button" className="g-btn ghost sm" aria-expanded={!closed} aria-label={t(closed ? "cr.unfold" : "cr.fold", {path: file.path})} onClick={toggleFold}>
        <Icon name={closed ? "ChevronRight" : "ChevronDown"} small/></button>
      <Icon name="FileDiff" small/>
      <strong className="git-path">{file.previousPath ? file.previousPath + " → " : ""}{file.path}</strong>
      {open > 0 && <span className="g-chip warn">{t("rv.open-n", {n: open})}</span>}
      <span className="g-muted">{what}{large ? " · " + t("cr.large") : ""}</span>
      <span className="git-cr-file-actions">
        {onOpen && <button type="button" className="g-btn ghost sm" title={t("cr.open-hint")} onClick={() => onOpen(null)}>{t("cr.open")}</button>}
        {onRevert && !file.deferred && file.changeKind !== "renamed" && file.changeKind !== "copied" &&
          <button type="button" className="g-btn ghost sm" aria-expanded={reverting} onClick={() => setReverting(value => !value)}>{t("cr.revert")}</button>}
        <button type="button" className="g-btn ghost sm" disabled={explaining} onClick={() => void onExplain({filePath: file.path, side: null, startLine: 0, endLine: 0, code: null})}>{t("cr.explain")}</button>
        <button type="button" className="g-btn ghost sm" aria-expanded={fileComment} onClick={() => setFileComment(value => !value)}>{t("cr.comment-file")}</button>
      </span>
    </header>
    {reverting && onRevert && <RevertForm path={file.path} changeKind={file.untracked ? "added" : file.changeKind} patch={hunksPickable ? file.patch : null}
      onRevert={hunks => onRevert(changeRevision(file), hunks)} onClose={() => setReverting(false)}/>}
    {!closed && <>
      {fileComment && <Composer label={t("cr.comment-on", {path: file.path})} withSeverity submitLabel={t("cr.comment")} onCancel={() => setFileComment(false)} draftKey={"file:" + file.path}
        onSubmit={async (body, severity) => { await onCreate({filePath: file.path, side: null, startLine: 0, endLine: 0, anchorContent: null, severity, body}); setFileComment(false); }}/>}
      {wholeFile.map(thread => <ThreadCard key={thread.id} thread={thread} api={api} current={undefined} canApply={false}/>)}
      {file.deferred ? (patchError
          ? <p className="git-error" role="alert">{t("cr.patch-failed", {error: patchError})} <button type="button" className="g-btn sm" onClick={onRetryPatch}>{t("cr.retry")}</button></p>
          : <p className="g-muted git-cr-note" role="status">{t("cr.reading-file")}</p>)
        : !file.patch ? <p className="g-muted git-cr-note">{t(file.binary ? "cr.binary" : "cr.too-large")}</p> :
        <div className="git-review-diff" data-wrap={wrap || undefined} role="group" aria-label={t("hs.patch-of", {path: file.path})}>
          {items.map((item, index) => <div key={index}>
            {item.kind === "hunk" ? <div className="git-review-row" data-kind="hunk"><span className="git-review-hunk">{item.text}</span></div>
              : item.kind === "single" ? <div className="git-review-row" data-kind={kindOf(item.row)} data-selected={inSelection(item.row) || undefined} {...mark(item.row)}>
                <button type="button" className="git-review-number" aria-label={item.row.kind === "deletion" ? t("cr.on-old-line", {n: item.row.oldLine!}) : t("cr.on-line", {n: item.row.newLine!})}
                  onClick={event => pick(item.row, event.shiftKey)}>{item.row.oldLine ?? ""}</button>
                <button type="button" className="git-review-number" tabIndex={-1} aria-hidden="true" onClick={event => pick(item.row, event.shiftKey)}>{item.row.newLine ?? ""}</button>
                <code className="git-review-code">{item.row.kind === "addition" ? "+" : item.row.kind === "deletion" ? "−" : " "}<CodeText text={item.row.text} tokens={tokensOf(indexOf.get(item.row) ?? -1)}/></code>
              </div>
              : <div className="git-review-split">{(["old", "new"] as const).map(side => {
                const row = item[side];
                const line = row ? (side === "old" ? row.oldLine : row.newLine) : null;
                const kind = !row ? "none" : row.kind === "context" ? "ctx" : side === "old" ? "del" : "add";
                return <div key={side} className="git-review-row" data-kind={kind} data-selected={row && line !== null && inSide(side, line) || undefined}
                  {...(side === "new" || row?.kind !== "context" ? mark(row) : {})}>
                  {row && line !== null ? <>
                    <button type="button" className="git-review-number" aria-label={t(side === "old" ? "cr.on-old-line" : "cr.on-line", {n: line})} onClick={event => pickAt(side, line, event.shiftKey)}>{line}</button>
                    <code className="git-review-code">{kind === "add" ? "+" : kind === "del" ? "−" : " "}<CodeText text={row.text} tokens={tokensOf(indexOf.get(row) ?? -1, side)}/></code>
                  </> : null}
                </div>;
              })}</div>}
            {anchorsOf(item).flatMap(anchor => below.get(keyOf(anchor.side, anchor.line)) ?? []).map(thread =>
              <ThreadCard key={thread.id} thread={thread} api={api} current={currentOf(thread)} canApply={workingCopy}/>)}
            {selection && range && anchorsOf(item).some(anchor => anchor.side === selection.side && anchor.line === range.end) && <div className="git-code-review-new">
              <Composer key={selection.side + range.start + "-" + range.end} label={t("cr.line-comment")} withSeverity code={selection.side === "new" ? selectedCode : null} submitLabel={t("cr.comment")}
                where={(range.start === range.end ? t("cr.line", {n: range.end}) : t("cr.lines", {from: range.start, to: range.end})) + (selection.side === "old" ? " · " + t("cr.removed") : "")}
                extra={<button type="button" className="g-btn ghost sm" disabled={explaining} onClick={() => { void onExplain({filePath: file.path, side: selection.side, startLine: range.start, endLine: range.end, code: selectedCode}); setSelection(null); }}>
                  {t(range.start === range.end ? "cr.explain-line" : "cr.explain-lines")}</button>}
                onCancel={() => setSelection(null)} draftKey={"line:" + file.path} draftRange={{side: selection.side, start: range.start, end: range.end}}
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
