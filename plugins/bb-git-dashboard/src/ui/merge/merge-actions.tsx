import { useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import { branchRows, previewLines, type BranchRow, type MergePreview } from "../../core/merge/branches.ts";
import { mergeRef } from "../../core/merge/conflicts.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import "./merge.css";

export type RunGit = (action: GitAction) => Promise<GitResult>;
type Author = {name: string; email: string};
export type Sequence = NonNullable<GitResult["sequence"]>;

/** Name and email for the commits a merge or rebase makes, asked only when the copy's Git config has none. */
function AuthorFields({value, onChange}: {value: Author; onChange(value: Author): void}) {
  return <div className="git-stack">
    <p className="git-muted">This copy has no Git author: name the one for the commits this makes.</p>
    <input aria-label="Git author name" placeholder="Git author name" value={value.name} onChange={event => onChange({...value, name: event.target.value})}/>
    <input aria-label="Git author email" placeholder="Git author email" value={value.email} onChange={event => onChange({...value, email: event.target.value})}/>
  </div>;
}
const authorOf = (state: GitResult, typed: Author) => state.author ? undefined : typed.name.trim() && typed.email.trim() ? {name: typed.name.trim(), email: typed.email.trim()} : null;

type Pending = {kind: "merge" | "rebase"; row: BranchRow; preview: MergePreview};

/**
 * The working copy's branches, each with Merge into the current branch and Rebase the current branch onto it. Both
 * start only on a clean tree with nothing in progress, after a confirmation that says what will come and conflict.
 */
export function BranchList({text, state, sequence, run, onChanged, onError}: {text: string; state: GitResult; sequence: Sequence | null; run: RunGit;
  onChanged(result: GitResult): void; onError(error: unknown): void}) {
  const rows = branchRows(text);
  const [pending, setPending] = useState<Pending | null>(null);
  const [fastForward, setFastForward] = useState(true);
  const [typed, setTyped] = useState<Author>({name: "", email: ""});
  const current = state.branch ?? "HEAD";
  const blocked = !state.head ? "There is no commit to merge into yet." : sequence ? "Finish or abort the " + sequence.kind + " in progress first."
    : state.files?.length ? "Commit or discard the changes first: a merge or rebase starts on a clean tree." : null;
  const ask = (kind: Pending["kind"], row: BranchRow) => {
    run({kind: "mergePreview", ref: row.ref, target: row.target}).then(result => {
      if (result.preview) { setFastForward(true); setPending({kind, row, preview: result.preview}); }
    }, onError);
  };
  const author = authorOf(state, typed);
  return <div className="git-stack">
    {blocked && <p className="git-muted">{blocked}</p>}
    <ul className="git-merge-branches" aria-label="Branches">
      {rows.map(row => {
        const here = !row.remote && row.name === state.branch;
        // Git allows names Makosh Git does not take as a ref to merge (`#`, `+`, non-ASCII letters).
        const named = mergeRef.test(row.ref) ? null : "Makosh Git merges branches named with letters, digits and . _ / - only.";
        return <li key={row.ref} className="git-row" data-current={here || undefined}>
          <span className="git-path">{row.name}</span>
          <code className="git-muted">{row.target.slice(0, 12)}</code>
          {row.remote && <span className="git-review-tag">remote</span>}
          {here ? <span className="git-review-tag">current</span> : row.worktree && <span className="git-muted git-path" title={row.worktree}>in another worktree</span>}
          <span className="git-ci-spacer"/>
          {!here && <>
            <button type="button" disabled={!!(blocked ?? named)} title={blocked ?? named ?? undefined} onClick={() => ask("merge", row)}>Merge into {current}</button>
            {state.branch && <button type="button" disabled={!!(blocked ?? named)} title={blocked ?? named ?? undefined} onClick={() => ask("rebase", row)}>Rebase onto</button>}
          </>}
        </li>;
      })}
    </ul>
    {pending && <ConfirmDialog title={pending.kind === "merge" ? "Merge " + pending.row.name + " into " + current : "Rebase " + current + " onto " + pending.row.name}
      lines={previewLines(pending.kind, pending.row.name, current, pending.preview, fastForward)}
      disabled={pending.preview.upToDate || author === null}
      onConfirm={async () => {
        const base = {ref: pending.row.ref, target: pending.row.target, expected: state.head!, ...(author ? {author} : {})};
        onChanged(await run(pending.kind === "merge" ? {kind: "merge", ...base, fastForward} : {kind: "rebase", ...base}));
      }}
      onClose={() => setPending(null)}>
      {pending.kind === "merge" && pending.preview.fastForward && <label className="git-review-check">
        <input type="checkbox" checked={fastForward} onChange={event => setFastForward(event.target.checked)}/> Fast-forward when possible (no merge commit)</label>}
      {author === null && <AuthorFields value={typed} onChange={setTyped}/>}
    </ConfirmDialog>}
  </div>;
}

/** Git's "us" and "them" in a conflict's state, named as the editor names the sides: in a rebase, "us" is the upstream. */
const stateText = (kind: Sequence["kind"], state: string) => kind === "rebase"
  ? state.replace("by us", "by the upstream").replace("by them", "by your commit").replace("both", "both sides") : state;

const kindLabel: Record<Sequence["kind"], string> = {merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert"};
type Step = "continue" | "skip" | "abort";

/** What is in progress: its conflicted files to resolve, and Continue, Skip (a rebase or cherry-pick) and Abort, each confirmed. */
export function SequenceBar({sequence, state, run, onChanged, onError, onResolve}: {sequence: Sequence; state: GitResult; run: RunGit;
  onChanged(result: GitResult): void; onError(error: unknown): void; onResolve(path: string): void}) {
  const [asked, setAsked] = useState<Step | null>(null);
  const [typed, setTyped] = useState<Author>({name: "", email: ""});
  const author = authorOf(state, typed);
  const where = sequence.step ? " · commit " + sequence.step.done + " of " + sequence.step.total : "";
  const left = sequence.conflicts.length;
  const lines: Record<Step, string[]> = {
    continue: [sequence.kind === "merge" ? "Commit the merge with the resolved files." : sequence.kind === "rebase" ? "Commit this step and replay the remaining commits." : "Commit the resolved files and go on."],
    skip: ["Drop the current commit" + (sequence.step ? " (" + sequence.step.done + " of " + sequence.step.total + ")" : "") + " and go on with the next one."],
    abort: ["Stop the " + sequence.kind + " and put the branch back where it was" + (sequence.head ? " (" + sequence.head.slice(0, 12) + ")" : "") + ".",
      "Resolutions made so far are lost."],
  };
  return <section className="git-merge-sequence" aria-label={kindLabel[sequence.kind] + " in progress"}>
    <div className="git-row">
      <strong>{kindLabel[sequence.kind]} in progress{where}</strong>
      <span className="git-muted">{left ? left + (left === 1 ? " conflicted file" : " conflicted files") : "No conflicts left"}</span>
      <span className="git-ci-spacer"/>
      <button type="button" className="git-primary" disabled={left > 0} title={left ? "Resolve every conflicted file first" : undefined} onClick={() => setAsked("continue")}>Continue</button>
      {(sequence.kind === "rebase" || sequence.kind === "cherry-pick") && <button type="button" onClick={() => setAsked("skip")}>Skip</button>}
      <button type="button" onClick={() => setAsked("abort")}>Abort</button>
    </div>
    {left > 0 && <ul className="git-merge-conflicts">{sequence.conflicts.map(conflict => <li key={conflict.path} className="git-row">
      <span className="git-path">{conflict.path}</span><span className="git-muted">{stateText(sequence.kind, conflict.state)}</span>
      <span className="git-ci-spacer"/><button type="button" onClick={() => onResolve(conflict.path)}>Resolve…</button>
    </li>)}</ul>}
    {asked && <ConfirmDialog title={asked === "continue" ? "Continue the " + sequence.kind : asked === "skip" ? "Skip this commit" : "Abort the " + sequence.kind}
      lines={lines[asked]} disabled={asked === "continue" && author === null}
      onConfirm={async () => { onChanged(await run(asked === "continue" ? {kind: "continue", ...(author ? {author} : {})} : {kind: asked})); }}
      onClose={() => setAsked(null)}>
      {asked === "continue" && author === null && <AuthorFields value={typed} onChange={setTyped}/>}
    </ConfirmDialog>}
  </section>;
}


/**
 * A commit reached the branch between the confirmation and the merge or rebase, which took it in. While the operation
 * is still in progress Abort puts everything back; once it is done, Undo returns the branch to where it was just
 * before (the late commit included), after a confirmation.
 */
export function RaceNotice({raced, made, head, branch, sequence, run, onChanged, onDismiss, onError}: {raced: string;
  /** The head the merge or rebase left: Undo is offered only while the branch is still there. */
  made: string | null; head: string | null; branch: string | null;
  sequence: Sequence | null; run: RunGit; onChanged(result: GitResult): void; onDismiss(): void; onError(error: unknown): void}) {
  const [asked, setAsked] = useState(false);
  // A commit made since (here or in a terminal) would be lost by going back: then Undo is not offered.
  const undoable = !!made && made === head;
  return <section className="git-merge-race" role="alert" aria-label="A commit arrived during the confirmation">
    <p>While you were confirming, commit <code>{raced.slice(0, 12)}</code> reached {branch ?? "the branch"}; the {sequence?.kind ?? "operation"} took it in.</p>
    <div className="git-row">
      {sequence ? <span className="git-muted">Abort the {sequence.kind} above to put everything back.</span>
        : undoable ? <button type="button" onClick={() => setAsked(true)}>Undo</button>
        : <span className="git-muted">The branch has moved on since: undo it by hand if you need to.</span>}
      <button type="button" onClick={onDismiss}>Keep it</button>
    </div>
    {asked && undoable && made && <ConfirmDialog title="Undo the merge or rebase" lines={["Put " + (branch ?? "the branch") + " back at " + raced.slice(0, 12) + ", the commit that arrived, as it was just before.",
      "Commits made by the merge or rebase leave the branch; local changes stay."]}
      onConfirm={async () => { onChanged(await run({kind: "undo", to: raced, expected: made})); onDismiss(); }}
      onClose={() => setAsked(false)}/>}
  </section>;
}
