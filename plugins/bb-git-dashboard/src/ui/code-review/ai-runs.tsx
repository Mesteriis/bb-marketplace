import { useEffect, useState } from "react";
import type { Execution, ReviewRun } from "../../core/code-review/model.ts";
import { REVIEW_FOCUSES } from "../../core/code-review/runs.ts";
import { message, type CodeReviewApi, type RunDefaults } from "./review-api.ts";
import { runStatusLabel, runTitle } from "./run-labels.ts";

/** The pickers' starting choice, read each time `active` turns on. */
export function useRunDefaults(api: CodeReviewApi, copyId: string, viewer: string | null, active: boolean) {
  const [defaults, setDefaults] = useState<RunDefaults | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setDefaults(null); setExecution(null); setError("");
    api.runDefaults(copyId, viewer).then(next => { if (live) { setDefaults(next); setExecution(next.execution); } },
      cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [api, copyId, viewer, active]);
  return {defaults, execution, setExecution, error};
}

/** Who runs it: BB's picker where the run would start, and the mode it starts in. */
export function ExecutionChoice({api, run, disabled}: {api: CodeReviewApi; run: ReturnType<typeof useRunDefaults>; disabled?: boolean}) {
  const {defaults, execution, setExecution, error} = run;
  const Picker = api.ExecutionPicker;
  return <div className="git-stack git-code-review-execution">
    <span className="git-muted">Runs in a new thread {defaults?.place?.kind === "environment" ? "under this one" : "in the working copy's project"}, on this working copy,
      in {defaults?.permissionMode === "accept-edits" ? "Accept edits" : "Approve for me"} mode (Makosh Git settings), or in full mode with a provider that lacks it.</span>
    {error ? <p className="git-error" role="alert">{error}</p>
      : !defaults ? <span className="git-muted" role="status">Loading the providers…</span>
      : defaults.place && execution ? <Picker value={execution} onChange={setExecution} routing={defaults.place} disabled={disabled}/>
      : null}
    {defaults?.message && <p className="git-warning" role="alert">{defaults.message}</p>}
  </div>;
}

/** "AI review": an agent reviews (with focuses) or summarizes the view in a thread of its own and comments here. */
export function AiReviewForm({api, copyId, sessionId, viewer, onClose, onStarted}: {
  api: CodeReviewApi; copyId: string; sessionId: string; viewer: string | null; onClose(): void; onStarted(run: ReviewRun, text: string): void;
}) {
  const run = useRunDefaults(api, copyId, viewer, true);
  const [mode, setMode] = useState<"review" | "summary">("review");
  const [focuses, setFocuses] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const toggle = (focus: string) => setFocuses(value => value.includes(focus) ? value.filter(item => item !== focus) : [...value, focus]);
  const start = async () => {
    if (!run.execution) return;
    setPending(true); setError("");
    try {
      const started = mode === "summary" ? await api.startSummary(sessionId, run.execution, viewer)
        : await api.startReview(sessionId, focuses, instructions, run.execution, viewer);
      onStarted(started, started.status === "failed" ? started.summary ?? "The run could not start."
        : mode === "summary" ? "Summary started; it appears here as a comment on the whole diff." : "AI review started; its comments appear here as it goes.");
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <fieldset className="git-ci-threads git-stack" aria-label="AI review">
    <legend>AI review</legend>
    <p className="git-muted">An agent reviews or summarizes this diff in a thread of its own and leaves comments here.</p>
    <div className="git-row" role="group" aria-label="What the agent does">
      <button type="button" aria-pressed={mode === "review"} className={mode === "review" ? "git-primary" : undefined} onClick={() => setMode("review")}>Review</button>
      <button type="button" aria-pressed={mode === "summary"} className={mode === "summary" ? "git-primary" : undefined} onClick={() => setMode("summary")}>Summarize</button>
    </div>
    {mode === "review" && <>
      <div className="git-row" role="group" aria-label="Focus (none: every pass)">
        <span className="git-muted">Focus (none: every pass)</span>
        {REVIEW_FOCUSES.map(focus => <button key={focus} type="button" aria-pressed={focuses.includes(focus)}
          className={focuses.includes(focus) ? "git-primary" : undefined} onClick={() => toggle(focus)}>{focus}</button>)}
      </div>
      <label className="git-ci-thread-note">Anything else to look at (optional)
        <textarea value={instructions} maxLength={4000} rows={3} onChange={event => setInstructions(event.target.value)}/></label>
    </>}
    <ExecutionChoice api={api} run={run} disabled={pending}/>
    <p className="git-muted">It is asked not to edit files, but BB cannot stop it; any file that changes while it runs is listed on the run.</p>
    <div className="git-row">
      <button type="button" className="git-primary" disabled={pending || !run.execution} onClick={() => void start()}>
        {pending ? "Starting…" : mode === "summary" ? "Summarize" : "Start review"}</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </fieldset>;
}

/** The view's AI runs not yet closed: what each is, where it stands, its thread, and Close, which archives it. */
export function RunList({api, runs, onClosed}: {api: CodeReviewApi; runs: ReviewRun[]; onClosed(): void}) {
  const [closing, setClosing] = useState("");
  const [error, setError] = useState("");
  if (!runs.length) return null;
  const close = async (run: ReviewRun) => {
    setClosing(run.id); setError("");
    try { await api.closeRun(run.id); onClosed(); }
    catch (cause) { setError(message(cause)); }
    finally { setClosing(""); }
  };
  return <section className="git-stack git-code-review-runs" aria-label="AI runs">
    <ul className="git-stack">{runs.map(run => <li key={run.id} className="git-code-review-run" data-status={run.status}>
      <div className="git-row">
        <strong>{runTitle(run)}</strong>
        <span className="git-review-tag" data-waiting={run.status === "running" || undefined} data-failed={run.status === "failed" || undefined}>{runStatusLabel[run.status]}</span>
        <span className="git-ci-spacer"/>
        {run.threadId && <button type="button" className="git-link" onClick={() => api.openThread(run.threadId!)}>Open thread</button>}
        <button type="button" disabled={closing === run.id} onClick={() => void close(run)}>{closing === run.id ? "Closing…" : "Close"}</button>
      </div>
      {run.kind !== "fix" && (run.changedFiles?.length ?? 0) > 0 &&
        <p className="git-warning">Files changed on this working copy while it ran: {run.changedFiles!.join(", ")}</p>}
      {run.status === "failed" && run.summary && <p className="git-muted">{run.summary}</p>}
    </li>)}</ul>
    {error && <p className="git-error" role="alert">{error}</p>}
  </section>;
}
