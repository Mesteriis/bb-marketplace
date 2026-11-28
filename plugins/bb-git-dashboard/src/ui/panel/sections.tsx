import { useEffect, useState, type ReactNode } from "react";
import { isTerminal, type Job, type Run } from "../../core/ci/model.ts";
import type { GitAction, GitResult } from "../../core/git.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { commitOfSummary, inIndex, isConflict as conflict, stageOfSummary } from "../../core/panel/changes.ts";
import { errorLines, prState } from "../../core/panel/summary.ts";
import type { InboxPr } from "../../core/pulls/model.ts";
import type { CiApi } from "../ci/ci-api.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";

type T = ReturnType<typeof useT>;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const tones: Record<string, string> = {M: "g-warn", A: "g-good", D: "g-bad", R: "g-vio", U: "g-bad", "?": "g-good"};

/** A part of the panel's summary: a heading that folds it, a line of what it holds on the right, and its body. */
export function Section({id, title, aside, open, onToggle, children}: {id: string; title: string; aside?: ReactNode; open: boolean; onToggle(): void; children?: ReactNode}) {
  return <section className="git-panel-section" aria-labelledby={id}>
    <h3 className="git-panel-section-head">
      <button type="button" id={id} aria-expanded={open} onClick={onToggle}><Icon name={open ? "ChevronDown" : "ChevronRight"} small/><span>{title}</span></button>
      {aside && <span className="git-panel-aside">{aside}</span>}
    </h3>
    {open && <div className="git-panel-section-body">{children}</div>}
  </section>;
}

/**
 * The working tree: each file with its box (checked: in the index), and the commit of what is staged. Conflicted files
 * and a copy without a commit author are sent to the copy's Changes, where they are resolved or set.
 */
export function ChangesBody({state, run, onChanged, onOpen}: {state: GitResult; run(action: GitAction): Promise<GitResult>; onChanged(): void;
  /** Opens the copy's Changes, at this file when one is named. */
  onOpen(path?: string): void}) {
  const t = useT();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const files = state.files ?? [];
  const conflicts = files.filter(conflict).length;
  const {staged, action: commit} = commitOfSummary(state, text);
  const act = async (action: GitAction) => {
    setPending(true); setError("");
    try { await run(action); onChanged(); return true; } catch (cause) { setError(message(cause)); return false; } finally { setPending(false); }
  };
  if (!files.length) return <p className="g-muted git-panel-empty">{t("pg.clean")}</p>;
  const canCommit = !pending && commit !== null;
  return <>
    {conflicts > 0 && <div className="g-banner warn git-panel-note-banner" role="status"><span>{t("gp.conflicts", {n: conflicts})}</span>
      <button type="button" className="g-btn sm" onClick={() => onOpen()}>{t("pg.resolve")}</button></div>}
    <ul className="git-panel-files" aria-label={t("gp.changes")}>{files.map(file => {
      const mark = (inIndex(file) ? file.index : file.worktree === "." ? file.index : file.worktree).replace(".", "?");
      const letter = file.index === "?" ? "U" : mark;
      const slash = file.path.lastIndexOf("/");
      return <li key={file.path}>
        <input type="checkbox" checked={inIndex(file)} disabled={pending || conflict(file)} aria-label={t(inIndex(file) ? "pg.unstage" : "pg.stage", {path: file.path})}
          onChange={() => void act(stageOfSummary(file))}/>
        <span className={"git-panel-mark " + (tones[letter === "U" && file.index === "?" ? "?" : letter] ?? "")}>{letter}</span>
        <button type="button" className="git-panel-path" title={file.path} onClick={() => onOpen(file.path)}>
          {slash >= 0 && <span className="g-muted">{file.path.slice(0, slash + 1)}</span>}{file.path.slice(slash + 1)}</button>
      </li>;
    })}</ul>
    <form className="git-panel-commit" onSubmit={event => { event.preventDefault(); if (canCommit && commit) void act(commit).then(done => { if (done) setText(""); }); }}>
      <input className="g-inp" aria-label={t("pg.message")} placeholder={t("pg.message")} maxLength={8000} value={text} onChange={event => setText(event.target.value)}/>
      <button type="submit" className="g-btn" disabled={!canCommit}>{t("pg.commit")}{staged ? " " + staged : ""}</button>
    </form>
    {!state.author && <p className="g-muted git-panel-empty">{t("gp.no-author")}
      <button type="button" className="g-btn ghost sm" onClick={() => onOpen()}>{t("gp.set-author")}</button></p>}
    {error && <p className="g-bad git-panel-error" role="alert">{error}</p>}
  </>;
}

const chipWord: Record<string, MessageKey> = {draft: "gp.pr.draft", conflict: "gp.pr.conflict", "ci-failed": "gp.pr.ci-failed", "ci-running": "gp.pr.ci-running",
  "ci-passed": "gp.pr.ci-passed", changes: "gp.pr.changes", approved: "gp.pr.approved", "review-waiting": "gp.pr.review-waiting", unanswered: "gp.pr.unanswered",
  "no-conflicts": "gp.pr.no-conflicts"};

/** The branch's open pull request: its title and state in chips, and the way to its page. */
export function PullBody({pull, branch, onOpen}: {pull: InboxPr | null; branch: string | null; onOpen(pull: InboxPr): void}) {
  const t = useT();
  if (!pull) return <p className="g-muted git-panel-empty">{branch ? t("gp.no-pr", {branch}) : t("gp.no-branch")}</p>;
  return <div className="git-panel-pr">
    <p className="git-panel-pr-title">{pull.title}</p>
    <div className="git-panel-chips">{prState(pull).map(chip => <span key={chip.key} className={"g-chip " + chip.tone}>{t(chipWord[chip.key]!, {n: chip.n ?? 0})}</span>)}
      <button type="button" className="g-btn ghost sm git-panel-more" onClick={() => onOpen(pull)}>{t("gp.open")}<Icon name="ChevronRight" small/></button></div>
  </div>;
}

const jobTone = (job: Job) => job.state === "success" ? "good" : job.state === "failure" ? "bad" : !isTerminal(job.state) ? "warn" : "line";
const stateWord = (state: string, t: T) => t((["success", "failure", "running", "queued", "waiting", "cancelled", "skipped"].includes(state) ? "gp.run." + state : "gp.run.other") as MessageKey);

/**
 * The branch's latest run: its jobs as chips and, when it failed, the error lines of its first failed job; an agent
 * fixes it, Re-run asks first, Log opens the run in the panel.
 */
export function CiBody({api, copyId, run, onLog}: {api: CiApi; copyId: string; run: Run; onLog(): void}) {
  const t = useT();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [lines, setLines] = useState<{number: number; text: string}[]>([]);
  const [failedJob, setFailedJob] = useState<Job | null>(null);
  const [ask, setAsk] = useState<{running: boolean; done: string}>({running: false, done: ""});
  const [confirm, setConfirm] = useState<{id: string; lines: string[]} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setJobs(null); setLines([]); setFailedJob(null);
    api.run(copyId, run.id).then(async detail => {
      if (!active) return;
      setJobs(detail.jobs);
      const failed = detail.jobs.find(job => job.state === "failure") ?? null;
      setFailedJob(failed);
      if (!failed) return;
      const log = await api.log(copyId, run.id, failed.id);
      if (active) setLines(errorLines((log.log?.text ?? "").split("\n"), log.errorLine));
    }).catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, run.id]);
  const finished = isTerminal(run.state);
  return <>
    {jobs === null ? <p className="g-muted" role="status">{t("common.loading")}</p>
      : <div className="git-panel-chips">{jobs.map(job => <span key={job.id} className={"g-chip " + jobTone(job)} title={stateWord(job.state, t)}>{job.name}</span>)}</div>}
    {lines.length > 0 && <pre className="git-panel-error-lines" aria-label={t("gp.ci-error")}>{lines.map(line =>
      <span key={line.number}><span className="git-panel-line-no">{line.number}</span>{line.text}{"\n"}</span>)}</pre>}
    <div className="git-panel-row">
      {run.state === "failure" && <button type="button" className="g-btn pri sm" disabled={ask.running} onClick={() => {
        setAsk({running: true, done: ""}); setError("");
        api.ask(copyId, run.id, failedJob?.id ?? null).then(result => setAsk({running: false, done: t(result.created ? "gp.ci-asked-new" : "gp.ci-asked")}),
          cause => { setAsk({running: false, done: ""}); setError(message(cause)); });
      }}><Icon name="Bot" small/>{t("gp.ci-fix")}</button>}
      {finished && <button type="button" className="g-btn sm" onClick={() => {
        setError("");
        api.prepare(copyId, {kind: "rerun", runId: run.id, failedOnly: run.state === "failure"}).then(setConfirm, cause => setError(message(cause)));
      }}><Icon name="RotateCcw" small/>{t("gp.ci-rerun")}</button>}
      <button type="button" className="g-btn ghost sm git-panel-more" onClick={onLog}>{t("gp.ci-log")}<Icon name="ChevronRight" small/></button>
    </div>
    {ask.done && <p className="g-muted" role="status">{ask.done}</p>}
    {error && <p className="g-bad git-panel-error" role="alert">{error}</p>}
    {confirm && <ConfirmDialog title={t("gp.ci-rerun")} lines={confirm.lines} onConfirm={() => api.confirm(confirm.id)} onClose={() => setConfirm(null)}/>}
  </>;
}

/** When a run ended or started, in words, with its state's mark. */
export function RunState({run, t}: {run: Run; t: T}) {
  const {language} = useLanguage();
  const when = ago(language, Date.now(), run.updatedAt ?? run.startedAt ?? run.createdAt);
  const tone = run.state === "success" ? "g-good" : run.state === "failure" ? "g-bad" : !isTerminal(run.state) ? "g-warn" : "g-muted";
  const icon = run.state === "success" ? "CircleCheck" : run.state === "failure" ? "CircleX" : run.state === "running" ? "Loading" : "Clock";
  const word = stateWord(run.state, t);
  return <span className={tone + " git-panel-runstate"}><Icon name={icon} small/>{when === t("time.now") ? word : t("gp.run-ago", {state: word, when})}</span>;
}
