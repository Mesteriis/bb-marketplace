import { useEffect, useState } from "react";
import type { CiAction } from "../../core/ci/actions.ts";
import type { Job, Run } from "../../core/ci/model.ts";
import { message, stateLabel, stateText, type CiApi, type RunsPage } from "./ci-api.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { LogView } from "./log-view.tsx";
import { ThreadPicker } from "./thread-picker.tsx";

/** One run: its jobs and steps, the selected job's log, re-run and cancel, and the hand-off to agents. */
export function RunDetail({api, copyId, runId, page, onBack, onChanged}: {
  api: CiApi; copyId: string; runId: string; page: RunsPage; onBack(): void; onChanged(): void;
}) {
  const [detail, setDetail] = useState<{run: Run; jobs: Job[]}>();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{title: string; id: string; lines: string[]}>();
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState<{threadId: string; created: boolean}>();
  const [asking, setAsking] = useState(false);
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
      if (result.run.state === "running" || result.run.state === "queued") timer = setTimeout(load, 15_000);
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
  if (!detail) return <div className="git-stack">
    <div className="git-row"><button type="button" onClick={onBack}>All runs</button></div>
    {error ? <p className="git-error" role="alert">{error}</p> : <p className="git-muted" role="status">Loading run…</p>}
  </div>;
  const {run, jobs} = detail;
  const job = jobs.find(item => item.id === jobId) ?? null;
  const finished = run.state !== "running" && run.state !== "queued";
  const ops = page.operations;
  return <div className="git-stack git-ci-run">
    <div className="git-row git-ci-run-title">
      <button type="button" onClick={onBack}>All runs</button>
      <h3>{run.workflow} #{run.number ?? run.id}</h3>
      <span className="git-state" data-state={run.state}>{stateText(run)}</span>
      <span className="git-muted">{[run.branch, run.event, run.attempt > 1 ? "attempt " + run.attempt : null].filter(Boolean).join(" · ")}</span>
      {run.url && <a href={run.url} target="_blank" rel="noreferrer">Open on the forge</a>}
    </div>
    <div className="git-row">
      {finished && ops.rerunFailed && run.state === "failure" &&
        <button type="button" onClick={() => void prepare("Re-run failed jobs", {kind: "rerun", runId, failedOnly: true})}>Re-run failed jobs</button>}
      {finished && ops.rerunAll && <button type="button" onClick={() => void prepare("Re-run all jobs", {kind: "rerun", runId, failedOnly: false})}>Re-run all jobs</button>}
      {!finished && ops.cancel && <button type="button" onClick={() => void prepare("Cancel run", {kind: "cancel", runId})}>Cancel run</button>}
      {run.state === "failure" && <button type="button" className="git-primary" disabled={asking} onClick={() => void ask()}>{asking ? "Asking…" : "Ask agent"}</button>}
      <button type="button" aria-expanded={sending} onClick={() => setSending(value => !value)}>Send to threads</button>
    </div>
    {asked && <p role="status">{asked.created ? "An agent is investigating this run. " : "This run is already being investigated. "}
      <button type="button" onClick={() => api.openThread(asked.threadId)}>Open thread</button></p>}
    {sending && <ThreadPicker api={api} copyId={copyId} label="Send this run with its error excerpt to" action="Send"
      onDone={async threadIds => {
        const result = await api.send(copyId, runId, jobId, threadIds);
        return "Sent to " + result.sent.length + (result.failed.length ? ", not delivered to " + result.failed.length : "") + ".";
      }}/>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="git-ci-run-body">
      <ul className="git-ci-jobs" aria-label="Jobs">{jobs.map(item => <li key={item.id}>
        <button type="button" aria-current={item.id === jobId ? "true" : undefined} onClick={() => setJobId(item.id)}>
          <span className="git-state" data-state={item.state}>{stateLabel[item.state]}</span> {item.name}
        </button>
        {item.id === jobId && item.steps.length > 0 && <ol className="git-ci-steps">{item.steps.map(step =>
          <li key={step.number}><span className="git-state" data-state={step.state}>{stateLabel[step.state]}</span> {step.name}</li>)}</ol>}
      </li>)}</ul>
      <div className="git-ci-log-pane">
        {!jobs.length && <p className="git-muted">No jobs yet.</p>}
        {job && <LogView key={job.id + revision} api={api} copyId={copyId} runId={runId} job={job}
          liveLog={ops.liveLog} liveLimitation={page.limitations.liveLog ?? null}/>}
      </div>
    </div>
    {preview && <ConfirmDialog title={preview.title} lines={preview.lines} onConfirm={() => api.confirm(preview.id)}
      onClose={done => { setPreview(undefined); if (done) { setRevision(value => value + 1); onChanged(); } }}/>}
  </div>;
}
