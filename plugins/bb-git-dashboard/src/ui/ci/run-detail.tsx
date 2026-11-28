import { useEffect, useRef, useState } from "react";
import type { CiAction } from "../../core/ci/actions.ts";
import { isActive, type Job, type Run } from "../../core/ci/model.ts";
import { jobSeconds, runSeconds } from "../../core/ci/summary.ts";
import { duration } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { forgeNames, message, stateKey, stateText, type CiApi, type RunsPage } from "./ci-api.ts";
import { RunState, Since, runName, useNow } from "./ci-parts.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { LogView } from "./log-view.tsx";
import { ThreadsDialog } from "./thread-picker.tsx";

/** A chip starts with a capital: "Failed", «Упал». */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const chipTone: Partial<Record<Run["state"], string>> = {failure: "bad", success: "good", running: "warn", queued: "warn", waiting: "warn"};

/**
 * One run as a page: the path back, its title and state, what it ran on, the actions (re-run, cancel, ask an agent,
 * send to threads, run again with inputs), its jobs with their durations and steps, and the chosen job's log.
 */
export function RunDetail({api, copyId, runId, page, notice = "", repository, onBack, onSection, onChanged, currentThreadId, onRunWith}: {
  api: CiApi; copyId: string; runId: string; onBack(): void; onChanged(): void;
  /** The repository's operations and limits; while unknown (the list did not load) the page offers no writes. */
  page?: RunsPage;
  /** Said under the actions: a run sent from here, say. */
  notice?: string;
  /** The repository's name, for the path. */
  repository: string;
  /** Goes to the CI/CD section over every repository; absent in a thread's tab. */
  onSection?(): void;
  /** Set in a thread's CI/CD tab: the run can be sent to that thread in one click. */
  currentThreadId?: string;
  /** Opens Run workflow with this run's workflow and branch; absent when the forge or token cannot start runs. */
  onRunWith?(run: Run): void;
}) {
  const t = useT();
  const {language} = useLanguage();
  const [detail, setDetail] = useState<{run: Run; jobs: Job[]}>();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{title: string; id: string; lines: string[]}>();
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState<{threadId: string; created: boolean}>();
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.run(copyId, runId).then(result => {
      if (!active) return;
      setDetail(result);
      // After a re-run a forge may give the jobs new ids; keep the selection only while it still exists.
      setJobId(current => result.jobs.some(job => job.id === current) ? current
        : (result.jobs.find(job => job.state === "failure") ?? result.jobs[0])?.id ?? null);
      if (isActive(result.run.state)) timer = setTimeout(load, 15_000);
    }, cause => { if (active) setError(message(cause)); });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, runId, revision]);

  const prepare = async (title: string, action: CiAction) => {
    setError("");
    try { setPreview({title, ...await api.prepare(copyId, action)}); }
    catch (cause) { setError(message(cause)); }
  };
  const ask = async () => {
    setError("");
    setAsking(true);
    try { setAsked(await api.ask(copyId, runId, jobId)); }
    catch (cause) { setError(message(cause)); }
    finally { setAsking(false); }
  };
  /** One-click actions report in the status line; their failures in the error line. */
  const quick = async (work: () => Promise<string>) => {
    setError(""); setStatus("");
    try { setStatus(await work()); }
    catch (cause) { setError(message(cause)); }
  };
  const now = useNow(!!detail && isActive(detail.run.state));
  const crumbs = (last: string) => <nav className="git-ci-path" aria-label={t("ci.path")}>
    {onSection ? <button type="button" className="g-btn ghost sm" onClick={onSection}>{t("section.ci")}</button> : <span>{t("section.ci")}</span>}
    <Icon name="ChevronRight" small/>
    <button type="button" className="g-btn ghost sm" onClick={onBack}>{repository || t("ci.runs")}</button>
    <Icon name="ChevronRight" small/><span className="g-muted">{last}</span>
  </nav>;
  if (!detail) return <div className="git-ci-run">
    <header className="git-ci-run-head">{crumbs("#" + runId)}</header>
    {error ? <div className="g-banner bad" role="alert">{error}</div> : <p className="g-state-page" role="status">{t("ci.run.loading")}</p>}
  </div>;
  const {run, jobs} = detail;
  const job = jobs.find(item => item.id === jobId) ?? null;
  const finished = !isActive(run.state);
  const ops = page?.operations ?? {dispatch: false, dispatchInputs: false, rerunFailed: false, rerunAll: false, cancel: false, liveLog: false};
  const failed = run.state === "failure";
  const rerunFailed = finished && ops.rerunFailed && failed;
  const name = run.workflow + " #" + (run.number ?? run.id);
  const seconds = runSeconds(run, now);
  const sendNote = failed ? t("ci.note.failed") : "";
  return <div className="git-ci-run">
    <header className="git-ci-run-head">
      {crumbs(name)}
      <div className="git-ci-run-title">
        <h1>{runName(run)}</h1>
        <span className={"g-chip " + (chipTone[run.state] ?? "line")}>{capital(stateText(t, run, now))}</span>
        <span className="git-ci-run-links">
          {run.url && <a className="git-ci-link" href={run.url} target="_blank" rel="noreferrer"><Icon name="ExternalLink" small/>{page ? t("ci.on-forge", {forge: forgeNames[page.forge]}) : t("ci.on-the-forge")}</a>}
          {run.url && <button type="button" className="g-btn" aria-label={t("ci.copy-link")} title={t("ci.copy-link")}
            onClick={() => void quick(async () => t(await api.copy(run.url!) ? "ci.link-copied" : "ci.copy-refused"))}><Icon name="Copy" small/></button>}
        </span>
      </div>
      <p className="git-ci-run-meta g-muted">
        {run.branch && <span className="g-branch" title={run.branch}>{run.branch}</span>}
        {[run.event, run.attempt > 1 ? t("ci.attempt", {n: run.attempt}) : null, seconds === null ? null : duration(language, seconds)].filter(Boolean).map(part => <span key={part}>{part}</span>)}
        <Since at={run.startedAt ?? run.createdAt} now={now}/>
      </p>
    </header>
    <div className="git-ci-run-actions" role="toolbar" aria-label={t("ci.run.actions")}>
      {rerunFailed && <button type="button" className="g-btn pri" onClick={() => void prepare(t("ci.rerun-failed"), {kind: "rerun", runId, failedOnly: true})}>
        <Icon name="RotateCcw" small/>{t("ci.rerun-failed")}</button>}
      {finished && ops.rerunAll && <button type="button" className={"g-btn" + (rerunFailed ? "" : " pri")} onClick={() => void prepare(t("ci.rerun-all"), {kind: "rerun", runId, failedOnly: false})}>
        {!rerunFailed && <Icon name="RotateCcw" small/>}{t("ci.rerun-all")}</button>}
      {!finished && ops.cancel && <button type="button" className="g-btn" onClick={() => void prepare(t("ci.cancel-run"), {kind: "cancel", runId})}>{t("ci.cancel-run")}</button>}
      {failed && <AskMenu busy={asking} onAsk={() => void ask()} onCompose={() => void quick(async () => { await api.compose(copyId, runId, jobId); return ""; })}/>}
      {currentThreadId && <button type="button" className="g-btn" onClick={() => void quick(async () => {
        const result = await api.send(copyId, runId, jobId, [currentThreadId], {note: sendNote, includeLogs: true});
        if (result.failed.length) throw new Error(result.failed[0]!.code);
        return t("ci.sent-here");
      })}>{t("ci.send-here")}</button>}
      <button type="button" className="g-btn" aria-haspopup="dialog" onClick={() => setSending(true)}><Icon name="Sent" small/>{t("ci.to-threads")}</button>
      {onRunWith && <button type="button" className="g-btn git-ci-end" disabled={!run.workflowId} title={run.workflowId ? undefined : t("ci.no-workflow")}
        onClick={() => onRunWith(run)}><Icon name="Play" small/>{t("ci.run-with")}</button>}
    </div>
    {asked && <div className="g-banner" role="status">{t(asked.created ? "ci.asked" : "ci.asked-already")}
      <button type="button" className="g-btn sm" onClick={() => api.openThread(asked.threadId)}>{t("ci.open-thread")}</button></div>}
    {(status || notice) && <p className="git-ci-status g-muted" role="status">{status || notice}</p>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    <div className="git-ci-run-body">
      <section className="git-ci-jobs-pane" aria-labelledby="git-ci-jobs-title">
        <h2 id="git-ci-jobs-title" className="g-sec">{t("ci.jobs")} <span className="g-num">{jobs.length}</span></h2>
        {!jobs.length && <p className="g-muted">{t("ci.no-jobs")}</p>}
        <ul className="git-ci-jobs" aria-label={t("ci.jobs")}>{jobs.map(item => {
          const took = jobSeconds(item, now);
          return <li key={item.id}>
            <button type="button" aria-current={item.id === jobId ? "true" : undefined} onClick={() => setJobId(item.id)}>
              <RunState state={item.state} text={t(stateKey(item.state))} quiet/><span className="git-ci-job-name">{item.name}</span>
              <span className="g-muted g-num git-ci-took" title={t(stateKey(item.state))}>{took === null ? t(stateKey(item.state)) : duration(language, took)}</span>
            </button>
            {item.id === jobId && item.steps.length > 0 && <ol className="git-ci-steps" aria-label={t("ci.steps-of", {name: item.name})}>{item.steps.map(step =>
              <li key={step.number}><RunState state={step.state} text={t(stateKey(step.state))} quiet/>{step.name}</li>)}</ol>}
          </li>;
        })}</ul>
      </section>
      <section className="git-ci-log-pane" aria-label={job ? t("ci.log.of", {name: job.name}) : t("ci.log")}>
        {job && <LogView key={job.id + revision} api={api} copyId={copyId} runId={runId} job={job}
          liveLog={ops.liveLog} liveLimitation={page?.limitations.liveLog ?? null}/>}
      </section>
    </div>
    {sending && <ThreadsDialog title={t("ci.send-title", {name})} onClose={() => setSending(false)} api={api} copyId={copyId}
      label={t("ci.send-to")} action={t("ci.send")} compose={{note: sendNote}}
      onDone={async (threadIds, options) => {
        const result = await api.send(copyId, runId, jobId, threadIds, options);
        return t("ci.sent", {n: result.sent.length}) + (result.failed.length ? " " + t("ci.not-sent", {n: result.failed.length}) : "");
      }}/>}
    {preview && <ConfirmDialog title={preview.title} lines={preview.lines} onConfirm={() => api.confirm(preview.id)}
      onClose={done => { setPreview(undefined); if (done) { setRevision(value => value + 1); onChanged(); } }}/>}
  </div>;
}

/** Ask agent ▾: start the investigation at once, or open the composer to choose the model. */
function AskMenu({busy, onAsk, onCompose}: {busy: boolean; onAsk(): void; onCompose(): void}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); close(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
      const at = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  // Closing gives the focus back to the button that opened the menu.
  function close() { setOpen(false); trigger.current?.focus(); }
  const pick = (run: () => void) => { close(); run(); };
  return <span className="git-ci-menu" ref={box}>
    <button ref={trigger} type="button" className="g-btn" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}>
      <Icon name="Bot" small/>{busy ? t("ci.asking") : t("ci.ask")}<Icon name="ChevronDown" small/></button>
    {open && <span className="git-ci-menu-list" role="menu" aria-label={t("ci.ask")}>
      <button type="button" role="menuitem" onClick={() => pick(onAsk)}>{t("ci.ask-now")}</button>
      <button type="button" role="menuitem" onClick={() => pick(onCompose)}>{t("ci.ask-model")}</button>
    </span>}
  </span>;
}
