import { useEffect, useMemo, useState } from "react";
import type { GitResult } from "../../core/git.ts";
import { conflictCount, hasMarkers, lineEnds, parseConflicts, resolveConflicts, type Choice, type Segment } from "../../core/merge/conflicts.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import type { RunGit, Sequence } from "./merge-actions.tsx";

type Block = Extract<Segment, {kind: "conflict"}>;
type Conflict = NonNullable<GitResult["conflict"]>;

/** What "ours" and "theirs" are in each kind of operation: in a rebase, ours is the branch being rebased onto. */
const sides: Record<Sequence["kind"], {ours: string; theirs: string}> = {
  merge: {ours: "Yours (current branch)", theirs: "Incoming"},
  rebase: {ours: "Upstream (rebasing onto)", theirs: "Your commit"},
  "cherry-pick": {ours: "Current branch", theirs: "Picked commit"},
  revert: {ours: "Current branch", theirs: "Reverted change"},
};

const sameChoice = (a: Choice | null, kind: Choice["kind"], first?: "ours" | "theirs") => a?.kind === kind && (!first || ("first" in a && a.first === first));

/** One conflict: the sides line by line, with a whole side, both, the base, picked lines or typed text as its answer. */
function ConflictBlock({block, index, total, choice, labels, onChoose}: {block: Block; index: number; total: number; choice: Choice | null;
  labels: {ours: string; theirs: string}; onChoose(choice: Choice | null): void}) {
  const picked = choice?.kind === "lines" ? choice : {kind: "lines" as const, ours: [] as number[], theirs: [] as number[], first: "ours" as const};
  const toggle = (side: "ours" | "theirs", line: number) => {
    const set = new Set(picked[side]);
    if (set.has(line)) set.delete(line); else set.add(line);
    const next = {...picked, [side]: [...set].sort((a, b) => a - b)};
    onChoose(next.ours.length || next.theirs.length ? next : null);
  };
  const column = (side: "ours" | "theirs") => <div className="git-merge-side" data-side={side}>
    <strong>{labels[side]}</strong>
    {block[side].length === 0 ? <p className="git-muted">(no lines)</p> : block[side].map((line, at) =>
      <label key={at} className="git-merge-line">
        <input type="checkbox" aria-label={"Take line " + (at + 1) + " of " + labels[side]} checked={choice?.kind === "lines" && choice[side].includes(at)}
          onChange={() => toggle(side, at)}/>
        <code>{line.replace(/\r$/, "") || " "}</code>
      </label>)}
  </div>;
  const [editing, setEditing] = useState(choice?.kind === "text");
  const short = {ours: labels.ours.split(" (")[0], theirs: labels.theirs.split(" (")[0]};
  return <article className="git-merge-block" aria-label={"Conflict " + (index + 1) + " of " + total} data-answered={choice ? true : undefined}>
    <div className="git-row">
      <strong>Conflict {index + 1} of {total}</strong>
      <span className="git-ci-spacer"/>
      {([["ours", labels.ours.split(" (")[0]], ["theirs", labels.theirs.split(" (")[0]]] as const).map(([kind, label]) =>
        <button key={kind} type="button" aria-pressed={sameChoice(choice, kind)} onClick={() => { setEditing(false); onChoose({kind}); }}>{label}</button>)}
      <button type="button" aria-pressed={sameChoice(choice, "both", "ours")} onClick={() => { setEditing(false); onChoose({kind: "both", first: "ours"}); }}>Both, {short.ours} first</button>
      <button type="button" aria-pressed={sameChoice(choice, "both", "theirs")} onClick={() => { setEditing(false); onChoose({kind: "both", first: "theirs"}); }}>Both, {short.theirs} first</button>
      {block.base && <button type="button" aria-pressed={sameChoice(choice, "base")} onClick={() => { setEditing(false); onChoose({kind: "base"}); }}>Base</button>}
      <button type="button" aria-pressed={editing} onClick={() => { setEditing(true); onChoose({kind: "text", text: (choice?.kind === "text" ? choice.text : block.ours.join("\n"))}); }}>Edit</button>
    </div>
    <div className="git-merge-sides" data-three={block.base ? true : undefined}>
      {column("ours")}
      {block.base && <div className="git-merge-side" data-side="base"><strong>Base (before both)</strong>
        {block.base.length === 0 ? <p className="git-muted">(no lines)</p> : block.base.map((line, at) => <code key={at} className="git-merge-base">{line.replace(/\r$/, "") || " "}</code>)}</div>}
      {column("theirs")}
    </div>
    {choice?.kind === "lines" && <label className="git-review-check">
      <input type="checkbox" checked={choice.first === "theirs"} onChange={event => onChoose({...choice, first: event.target.checked ? "theirs" : "ours"})}/> Put the picked lines of {labels.theirs.split(" (")[0]} first</label>}
    {editing && choice?.kind === "text" && <textarea aria-label={"Text for conflict " + (index + 1)} rows={Math.min(12, Math.max(3, choice.text.split("\n").length + 1))}
      value={choice.text} onChange={event => onChoose({kind: "text", text: event.target.value})}/>}
  </article>;
}

/**
 * Resolves one conflicted file. The conflicts are the ones left in the file as it is, so conflicts already answered
 * by hand in another editor stay answered; each gets an answer, the result can be edited as a whole, and Save writes
 * it over the file as it was read and marks it resolved. A file one side deleted, or that is not text, is taken whole
 * from a side or deleted; every write refuses a file changed since it was read.
 */
export function ConflictEditor({path, kind, run, onChanged, onClose, onError}: {path: string; kind: Sequence["kind"]; run: RunGit;
  onChanged(result: GitResult): void; onClose(): void; onError(error: unknown): void}) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [choices, setChoices] = useState<(Choice | null)[]>([]);
  const [edited, setEdited] = useState<string | null>(null);
  const [asked, setAsked] = useState<{title: string; lines: string[]; action: Parameters<RunGit>[0]} | null>(null);
  useEffect(() => {
    let live = true;
    run({kind: "conflict", path}).then(result => {
      if (!live || !result.conflict) return;
      setConflict(result.conflict);
      setChoices(Array(conflictCount(parseConflicts(result.conflict.current ?? ""))).fill(null));
      setEdited(null);
    }, onError);
    return () => { live = false; };
  }, [path, run, onError]);
  const parsed = useMemo(() => parseConflicts(conflict?.current ?? ""), [conflict]);
  const labels = sides[kind];
  if (!conflict) return <section className="git-merge-editor" aria-label={"Resolve " + path}><p className="git-muted" role="status">Reading the conflict…</p></section>;
  const textual = !conflict.binary && conflict.current !== null && conflict.ours !== null && conflict.theirs !== null;
  // A hand edit of the result is typed with LF line ends; it goes back with the file's own.
  const resolved = edited !== null ? lineEnds(edited, conflict.current) : resolveConflicts(parsed, choices);
  const left = choices.filter(choice => !choice).length;
  const blocks = parsed.segments.filter((segment): segment is Block => segment.kind === "conflict");
  const whole = (side: "ours" | "theirs" | "delete") => ({
    title: side === "delete" ? "Delete " + path : "Take " + path + " from " + labels[side],
    lines: [side === "delete" ? "Remove the file and mark the conflict resolved." :
      (side === "ours" ? conflict.ours : conflict.theirs) === null ? labels[side] + " has no " + path + ": it is removed and the conflict marked resolved."
        : "Replace the file with " + labels[side] + "'s version and mark the conflict resolved."],
    action: {kind: "take" as const, path, side, expected: conflict.sha256},
  });
  return <section className="git-merge-editor" aria-label={"Resolve " + path}>
    <header className="git-row">
      <h3 className="git-path">{path}</h3>
      {textual && <span className="git-muted">{blocks.length} {blocks.length === 1 ? "conflict" : "conflicts"}{left ? " · " + left + " to answer" : ""}</span>}
      <span className="git-ci-spacer"/>
      <button type="button" onClick={() => setAsked(whole("ours"))}>Take {labels.ours.split(" (")[0]}</button>
      <button type="button" onClick={() => setAsked(whole("theirs"))}>Take {labels.theirs.split(" (")[0]}</button>
      <button type="button" onClick={() => setAsked(whole("delete"))}>Delete file</button>
      <button type="button" onClick={onClose}>Close</button>
    </header>
    {!textual ? <p className="git-muted">{conflict.binary ? "This file is not text: take one side whole, or delete it."
      : conflict.ours === null || conflict.theirs === null ? (conflict.ours === null ? labels.ours : labels.theirs) + " deleted this file and the other side changed it: take one side, or delete it."
      : "The file is missing from the working copy: take one side, or delete it."}</p> : <>
      {blocks.length === 0 && <p className="git-muted">No conflict markers are left in the file: it can be marked resolved as it is.</p>}
      {blocks.map((block, index) => <ConflictBlock key={index} block={block} index={index} total={blocks.length} choice={choices[index] ?? null} labels={labels}
        onChoose={choice => { setEdited(null); setChoices(previous => previous.map((value, at) => at === index ? choice : value)); }}/>)}
      <div className="git-stack git-merge-result">
        <div className="git-row"><strong>Result</strong>
          {edited !== null && <button type="button" className="git-link" onClick={() => setEdited(null)}>Undo edits</button>}</div>
        {resolved === null ? <p className="git-muted">Answer every conflict to see the result; then it can be edited before saving.</p>
          : <textarea aria-label="Resolved text" className="git-merge-text" rows={Math.min(24, resolved.split("\n").length + 1)} value={resolved}
            onChange={event => setEdited(event.target.value)}/>}
        {resolved !== null && hasMarkers(resolved) && <p className="git-error" role="alert">The result still has conflict markers.</p>}
        <div className="git-row">
          <button type="button" className="git-primary" disabled={resolved === null || hasMarkers(resolved)}
            onClick={() => resolved !== null && setAsked({title: "Save " + path, lines: ["Write the result over " + path + " and mark the conflict resolved.",
              resolved.split("\n").length + " lines."], action: {kind: "resolve", path, expected: conflict.sha256!, text: lineEnds(resolved, conflict.current)}})}>Save and mark resolved</button>
        </div>
      </div>
    </>}
    {asked && <ConfirmDialog title={asked.title} lines={asked.lines} onConfirm={async () => { onChanged(await run(asked.action)); }}
      onClose={done => { setAsked(null); if (done) onClose(); }}/>}
  </section>;
}
