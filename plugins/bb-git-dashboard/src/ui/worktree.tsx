import { useCallback, useEffect, useId, useState } from "react";
import type { GitAction, GitResult } from "../core/git.ts";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import { homeRelative } from "../core/short-path.ts";
import type { Copy, Operation } from "../core/workspace.ts";
import { useT } from "./i18n/use-t.tsx";
import { ConflictEditor } from "./merge/conflict-editor.tsx";
import { RaceNotice, SequenceBar, type Sequence } from "./merge/merge-actions.tsx";
import { Activity } from "./project/activity.tsx";
import { Branches } from "./project/branches.tsx";
import { Changes } from "./project/changes.tsx";
import { PushDialog } from "./project/project-head.tsx";
import { Worktrees } from "./project/worktrees.tsx";
import { Icon } from "./system/icon.tsx";

export type RunGit = (action: GitAction) => Promise<GitResult>;
type View = "changes" | "branches" | "worktrees" | "activity";
const views: View[] = ["changes", "branches", "worktrees", "activity"];

/** A copy's Code: Changes, Branches, Worktrees and Activity as tabs, with the copy's machine and path; a merge or rebase in progress above them. */
export function Worktree({copy, host, run, refresh, loadOperations, attach, pin, openReview}: {
  copy: Copy;
  host: string;
  run: RunGit;
  refresh: number;
  loadOperations(): Promise<Operation[]>;
  attach?(root: string): Promise<void>;
  pin?(): void;
  /** Opens the file in the copy's line review. */
  openReview?(path: string): void;
}) {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<View>("changes");
  const [state, setState] = useState<GitResult>();
  const [detail, setDetail] = useState<GitResult>();
  const [activity, setActivity] = useState<Operation[]>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [push, setPush] = useState<{head: string; branch: string; origin: string; ahead: number} | null>(null);
  // A merge, rebase, cherry-pick or revert left in progress, and the conflicted file open in the editor.
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  // A commit taken in by a merge or rebase that arrived while it was being confirmed.
  const [raced, setRaced] = useState<{sha: string; made: string | null} | null>(null);

  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : "Request failed"), []);
  const reread = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    Promise.all([run({kind: "status"}), run({kind: "sequence"})]).then(([result, progress]) => {
      if (active) { setState(result); setSequence(progress.sequence ?? null); }
    }, cause => { if (active) report(cause); });
    return () => { active = false; };
  }, [run, revision, refresh, report]);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setActivity(undefined);
    const kind = view === "branches" ? "branches" : view === "worktrees" ? "worktrees" : null;
    if (kind) run({kind}).then(value => { if (active) setDetail(value); }, cause => { if (active) report(cause); });
    else if (view === "activity") loadOperations().then(value => { if (active) setActivity(value); }, cause => { if (active) report(cause); });
    return () => { active = false; };
  }, [view, run, loadOperations, revision, refresh, report]);
  useEffect(() => { setCreating(false); }, [view]);

  const act = useCallback(async (action: GitAction): Promise<boolean> => {
    setPending(true);
    setError("");
    try {
      const result = await run(action);
      if (result.text === "BRANCH_OCCUPIED") { setError(t("pg.branch-occupied", {path: result.worktrees?.[0]?.path ?? ""})); return false; }
      reread();
      return true;
    } catch (cause) { report(cause); return false; }
    finally { setPending(false); }
  }, [run, report, reread, t]);
  const actAll = useCallback(async (actions: GitAction[]) => {
    setPending(true);
    setError("");
    try { for (const action of actions) await run(action); }
    catch (cause) { report(cause); }
    finally { setPending(false); reread(); }
  }, [run, report, reread]);
  // Push goes to a local origin only: a network origin answers ACCOUNT_TRANSPORT_REQUIRED, said before anything is committed.
  const canPush = useCallback(async () => {
    try { const origin = await run({kind: "localOrigin"}); if (origin.text) return true; setError("NO_ORIGIN"); return false; }
    catch (cause) { report(cause); return false; }
  }, [run, report]);
  const askPush = async () => {
    try {
      const status = await run({kind: "status"});
      const origin = await run({kind: "localOrigin"});
      if (!status.head || !status.branch || !origin.text) { setError("NO_ORIGIN"); return; }
      setPush({head: status.head, branch: status.branch, origin: origin.text, ahead: status.ahead ?? 0});
    } catch (cause) { report(cause); }
  };

  const counts: Partial<Record<View, number>> = {changes: state?.files?.length ?? 0,
    branches: view === "branches" && detail?.text !== undefined ? detail.text.split("\n").filter(line => line.startsWith("refs/heads/")).length : undefined,
    worktrees: view === "worktrees" ? detail?.worktrees?.length : undefined};
  return <div className="git-codeview">
    <div className="git-code-bar">
      <div className="g-seg" role="tablist" aria-label={t("pg.views")}>
        {views.map(name => <button key={name} id={id + name} type="button" role="tab" aria-selected={view === name} aria-controls={id + "panel"}
          tabIndex={view === name ? 0 : -1} data-view={name} onClick={() => setView(name)} onKeyDown={event => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next = event.key === "Home" ? views[0]! : event.key === "End" ? views[views.length - 1]!
              : step ? views[(views.indexOf(name) + step + views.length) % views.length]! : null;
            if (!next) return;
            event.preventDefault();
            setView(next);
            (event.currentTarget.parentElement?.querySelector("[data-view=\"" + next + "\"]") as HTMLElement | null)?.focus();
          }}>{t(("pg.view." + name) as MessageKey)}{counts[name] ? <span className="g-num g-muted">{counts[name]}</span> : null}</button>)}
      </div>
      <span className="g-muted git-code-place" title={host + " · " + copy.root}><Icon name="FolderGit" small/>{host} · <span className="g-mono">{homeRelative(copy.root)}</span></span>
      {pin && <button type="button" className="g-btn ghost sm" onClick={pin}>{t("pg.pin")}</button>}
      <button type="button" className="g-btn ghost sm" onClick={() => { setError(""); reread(); }}><Icon name="RotateCcw" small/>{t("pg.refresh")}</button>
      {view === "branches" && <button type="button" className="g-btn sm" onClick={() => setCreating(true)}>+ {t("br.create")}</button>}
      {view === "worktrees" && <button type="button" className="g-btn sm" onClick={() => setCreating(true)}>+ {t("wt.create")}</button>}
    </div>
    {error && <p role="alert" className="g-banner bad">{error}</p>}
    {pending && <p role="status" className="g-sr">{t("pg.working")}</p>}
    {state && raced && <RaceNotice raced={raced.sha} made={raced.made} head={state.head ?? null} branch={state.branch ?? null} sequence={sequence} run={run} onError={report}
      onChanged={reread} onDismiss={() => setRaced(null)}/>}
    {state && sequence && <SequenceBar sequence={sequence} state={state} run={run} onError={report} onResolve={setResolving}
      onChanged={() => { setResolving(null); reread(); }}/>}
    {resolving && sequence && <ConflictEditor key={resolving} path={resolving} kind={sequence.kind} run={run} onError={report}
      onChanged={reread} onClose={() => setResolving(null)}/>}
    <div role="tabpanel" id={id + "panel"} aria-labelledby={id + view} className="git-code-panel">
      {!state ? <p className="g-muted" role="status">{t("pg.reading")}</p>
        : view === "changes" ? <Changes state={state} sequence={sequence} run={run} pending={pending} revision={revision + refresh} act={act} actAll={actAll}
          onResolve={setResolving} onError={report} openReview={openReview} canPush={canPush} onCommitted={pushToo => { if (pushToo) void askPush(); }}/>
        : view === "branches" ? (detail?.text !== undefined
          ? <Branches text={detail.text} state={state} sequence={sequence} run={run} pending={pending} act={act} onError={report} creating={creating} onCreating={setCreating}
            onChanged={result => { reread(); setRaced(result.raced ? {sha: result.raced, made: result.head ?? null} : null); if (result.sequence?.conflicts.length) setResolving(result.sequence.conflicts[0]!.path); }}/>
          : <p className="g-muted" role="status">{t("pg.reading-branches")}</p>)
        : view === "worktrees" ? (detail?.worktrees
          ? <Worktrees copy={copy} host={host} trees={detail.worktrees} state={state} pending={pending} act={act} attach={attach} onError={report} creating={creating} onCreating={setCreating}/>
          : <p className="g-muted" role="status">{t("pg.reading")}</p>)
        : <Activity operations={activity} now={Date.now()}/>}
    </div>
    {push && <PushDialog {...push} onConfirm={async () => {
      await run({kind: "push", expected: push.head, branch: push.branch, destination: push.origin});
      reread();
    }} onClose={() => setPush(null)}/>}
  </div>;
}
