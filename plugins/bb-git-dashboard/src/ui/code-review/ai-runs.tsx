import { useEffect, useState } from "react";
import type { Execution, ReviewRun } from "../../core/code-review/model.ts";
import { REVIEW_FOCUSES } from "../../core/code-review/runs.ts";
import { message, type CodeReviewApi, type RunDefaults } from "./review-api.ts";
import { runStatusLabel, runTitle } from "./run-labels.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { useT } from "../i18n/use-t.tsx";
import { Dialog } from "../system/dialog.tsx";

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
  const t = useT();
  const {defaults, execution, setExecution, error} = run;
  const Picker = api.ExecutionPicker;
  return <div className="git-code-review-execution">
    {error ? <p className="git-error" role="alert">{error}</p>
      : !defaults ? <span className="g-muted" role="status">{t("ai.loading-providers")}</span>
      : defaults.place && execution ? <Picker value={execution} onChange={setExecution} routing={defaults.place} disabled={disabled}/>
      : null}
    {defaults?.message && <p className="git-warning" role="alert">{defaults.message}</p>}
    <span className="g-muted">{t(defaults?.place?.kind === "environment" ? "ai.where-thread" : "ai.where-project",
      {mode: t(defaults?.permissionMode === "accept-edits" ? "ai.mode-edits" : "ai.mode-auto")})}</span>
  </div>;
}

/** "AI review": an agent reviews (with focuses) or summarizes the view in a thread of its own and comments here. */
export function AiReviewForm({api, copyId, sessionId, viewer, onClose, onStarted}: {
  api: CodeReviewApi; copyId: string; sessionId: string; viewer: string | null; onClose(): void; onStarted(run: ReviewRun, text: string): void;
}) {
  const t = useT();
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
      onStarted(started, started.status !== "running" ? started.summary ?? t("ai.closed-early") : t(mode === "summary" ? "ai.summary-started" : "ai.review-started"));
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  // Not modal: BB's model picker opens its list outside the dialog, which a modal one would hide behind it.
  return <Dialog title={t("cr.ai")} busy={pending} onClose={onClose} modal={false} actions={<>
    <button type="button" className="g-btn" disabled={pending} onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" className="g-btn pri" disabled={pending || !run.execution} onClick={() => void start()}>
      {pending ? t("ai.starting") : t(mode === "summary" ? "ai.summarize" : "ai.start")}</button>
  </>}>
    <div className="git-ai-form" role="form" aria-label={t("cr.ai")}>
      <p className="g-muted">{t("ai.what-it-does")}</p>
      <span className="git-ai-label" id="git-ai-mode">{t("ai.mode")}</span>
      <div className="g-seg" role="group" aria-labelledby="git-ai-mode">
        <button type="button" aria-pressed={mode === "review"} onClick={() => setMode("review")}>{t("ai.review")}</button>
        <button type="button" aria-pressed={mode === "summary"} onClick={() => setMode("summary")}>{t("ai.summary")}</button>
      </div>
      {mode === "review" && <>
        <span className="git-ai-label" id="git-ai-focus">{t("ai.focus")}</span>
        <div className="git-ai-chips" role="group" aria-labelledby="git-ai-focus">
          {REVIEW_FOCUSES.map(focus => <button key={focus} type="button" className="g-chip line git-ai-chip" aria-pressed={focuses.includes(focus)}
            onClick={() => toggle(focus)}>{t(("ai.f." + focus.toLowerCase()) as MessageKey)}</button>)}
        </div>
        <label className="git-ai-label">{t("ai.more")}
          <textarea className="g-inp" value={instructions} maxLength={4000} rows={3} placeholder={t("ai.optional")} onChange={event => setInstructions(event.target.value)}/></label>
      </>}
      <span className="git-ai-label">{t("ai.model")}</span>
      <ExecutionChoice api={api} run={run} disabled={pending}/>
      <p className="g-muted">{t("ai.no-edit")}</p>
      {error && <p className="git-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}

/** The view's AI runs not yet closed: what each is, where it stands, its thread, and Close, which archives it. */
export function RunList({api, runs, onClosed}: {api: CodeReviewApi; runs: ReviewRun[]; onClosed(): void}) {
  const t = useT();
  const [closing, setClosing] = useState("");
  const [error, setError] = useState("");
  if (!runs.length) return null;
  const close = async (run: ReviewRun) => {
    setClosing(run.id); setError("");
    try { await api.closeRun(run.id); onClosed(); }
    catch (cause) { setError(message(cause)); }
    finally { setClosing(""); }
  };
  return <section className="git-code-review-runs" aria-label={t("ai.runs")}>
    <ul>{runs.map(run => <li key={run.id} className="git-code-review-run" data-status={run.status}>
      <div className="git-cr-run-line">
        <strong>{t(runTitle(run).key, runTitle(run).values)}</strong>
        <span className={"g-chip " + (run.status === "running" ? "warn" : run.status === "failed" ? "bad" : run.status === "done" ? "good" : "line")}>{t(runStatusLabel[run.status])}</span>
        <span className="git-cr-end">
          {run.threadId && <button type="button" className="g-btn ghost sm" onClick={() => api.openThread(run.threadId!)}>{t("ci.open-thread")}</button>}
          <button type="button" className="g-btn ghost sm" disabled={closing === run.id} onClick={() => void close(run)}>{closing === run.id ? t("ai.closing") : t("ci.close")}</button>
        </span>
      </div>
      {run.kind !== "fix" && (run.changedFiles?.length ?? 0) > 0 &&
        <p className="git-warning">{t("ai.changed", {files: run.changedFiles!.join(", ")})}</p>}
      {run.status === "failed" && run.summary && <p className="g-muted">{run.summary}</p>}
    </li>)}</ul>
    {error && <p className="git-error" role="alert">{error}</p>}
  </section>;
}
