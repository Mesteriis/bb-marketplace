import { useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import { previewLines, type BranchRow, type MergePreview } from "../../core/merge/branches.ts";
import { ago } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
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
 * The working copy's branches as a table: the branch (current, in another worktree), what it tracks and how far it is,
 * its last commit, and Switch, Merge into the current branch and Rebase onto it (under ⋯). A merge or rebase starts
 * only on a clean tree with nothing in progress, after a confirmation that says what will come and conflict.
 */
export function BranchList({rows, state, sequence, run, now, pending: busy, onSwitch, onChanged, onError}: {rows: BranchRow[]; state: GitResult;
  sequence: Sequence | null; run: RunGit; now: number; pending: boolean; onSwitch(branch: string): void;
  onChanged(result: GitResult): void; onError(error: unknown): void}) {
  const t = useT();
  const {language} = useLanguage();
  const [pending, setPending] = useState<Pending | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [fastForward, setFastForward] = useState(true);
  const [typed, setTyped] = useState<Author>({name: "", email: ""});
  const current = state.branch ?? "HEAD";
  const blocked = !state.head ? t("br.blocked-empty") : sequence ? t("br.blocked-sequence", {kind: sequence.kind})
    : state.files?.length ? t("br.blocked-dirty") : null;
  const ask = (kind: Pending["kind"], row: BranchRow) => {
    setMenu(null);
    run({kind: "mergePreview", ref: row.ref, target: row.target}).then(result => {
      if (result.preview) { setFastForward(true); setPending({kind, row, preview: result.preview}); }
    }, onError);
  };
  const author = authorOf(state, typed);
  return <div className="git-branches-table">
    {blocked && <p className="g-muted git-branches-note">{blocked}</p>}
    <table className="g-table two" aria-label={t("pg.view.branches")}>
      <thead><tr><th>{t("br.col.branch")}</th><th>{t("br.col.tracks")}</th><th>{t("pj.col.sync")}</th><th>{t("br.col.last")}</th><th><span className="g-sr">{t("br.col.actions")}</span></th></tr></thead>
      <tbody>{rows.map(row => {
        const here = !row.remote && row.name === state.branch;
        // Git allows names Makosh Git does not take as a ref to merge (`#`, `+`, non-ASCII letters).
        const named = mergeRef.test(row.ref) ? null : t("br.unnamed");
        const why = blocked ?? named ?? undefined;
        const elsewhere = !here && row.worktree ? row.worktree : null;
        return <tr key={row.ref} data-branch={row.name} aria-current={here || undefined}>
          <td><span className="g-branch">{row.name}</span>{here && <span className="g-chip vio git-branches-chip">{t("br.current")}</span>}
            {elsewhere && <span className="g-chip line git-branches-chip" title={elsewhere}>{t("br.elsewhere")}</span>}</td>
          <td className="g-mono g-muted">{row.remote ? "—" : row.gone ? t("br.gone") : row.upstream ?? t("pg.no-upstream")}</td>
          <td className="g-num">{row.ahead || row.behind ? <>{row.ahead ? <span>↑{row.ahead}</span> : null} {row.behind ? <span className="g-warn">↓{row.behind}</span> : null}</> : "—"}</td>
          <td>{row.subject ? <div className="git-branches-last"><span>{row.subject}</span>
            <span className="g-muted" title={row.date ?? undefined}>{[row.author, row.date ? ago(language, now, row.date) : null].filter(Boolean).join(" · ")}</span></div>
            : <span className="g-mono g-muted">{row.target.slice(0, 7)}</span>}</td>
          <td className="git-branches-actions">{!here && <>
            {!row.remote && <button type="button" className="g-btn sm" disabled={busy || !!elsewhere} title={elsewhere ? t("br.in-worktree", {path: elsewhere}) : undefined}
              onClick={() => onSwitch(row.name)}>{t("br.switch")}</button>}
            <button type="button" className="g-btn sm" disabled={!!why} title={why} onClick={() => ask("merge", row)}>{t("br.merge")}</button>
            {state.branch && <span className="git-branches-more" onKeyDown={event => { if (event.key === "Escape" && menu === row.ref) { event.stopPropagation(); setMenu(null);
                (event.currentTarget.firstElementChild as HTMLElement | null)?.focus(); } }}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(null); }}>
              <button type="button" className="g-btn ghost sm" aria-label={t("br.more", {name: row.name})} aria-expanded={menu === row.ref}
                onClick={() => setMenu(menu === row.ref ? null : row.ref)}><Icon name="MoreHorizontal" small/></button>
              {menu === row.ref && <span className="git-branches-menu" role="group" aria-label={t("br.more", {name: row.name})}>
                <button type="button" className="g-btn ghost sm" disabled={!!why} title={why} onClick={() => ask("rebase", row)}>{t("br.rebase")}</button>
              </span>}
            </span>}
          </>}</td>
        </tr>;
      })}</tbody>
    </table>
    <p className="g-muted git-branches-note">{t("br.note")}</p>
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
