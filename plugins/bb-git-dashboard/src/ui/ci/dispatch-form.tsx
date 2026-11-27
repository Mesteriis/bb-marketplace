import { useEffect, useState, type FormEvent } from "react";
import { dispatchValues, type DispatchInput, type DispatchSpec } from "../../core/ci/dispatch.ts";
import type { Workflow } from "../../core/ci/pipelines.ts";
import { message, type CiApi } from "./ci-api.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";

function initialValues(inputs: DispatchInput[]) {
  return Object.fromEntries(inputs.map(input => [input.name, input.default ?? (input.type === "boolean" ? "false" : input.type === "choice" ? input.options[0] ?? "" : "")]));
}

/** Runs a workflow by hand with the inputs its `workflow_dispatch` trigger declares. */
export function DispatchForm({api, copyId, inputsLimitation, onClose, onDone}: {
  api: CiApi; copyId: string; inputsLimitation: string | null; onClose(): void; onDone(): void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>();
  const [workflowId, setWorkflowId] = useState("");
  const [ref, setRef] = useState("");
  const [spec, setSpec] = useState<DispatchSpec>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{id: string; lines: string[]}>();
  useEffect(() => {
    let active = true;
    api.workflows(copyId).then(result => {
      if (!active) return;
      setWorkflows(result.workflows);
      setWorkflowId(result.workflows[0]?.id ?? "");
      setRef(result.defaultBranch ?? "");
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId]);
  useEffect(() => {
    if (!workflowId || !ref.trim()) return;
    let active = true;
    setSpec(undefined);
    const timer = setTimeout(() => api.form(copyId, workflowId, ref.trim()).then(result => {
      if (!active) return;
      setSpec(result);
      setValues(initialValues(result.inputs));
      setError("");
    }, cause => { if (active) setError(message(cause)); }), 400);
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, workflowId, ref]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const missing = spec?.inputs.filter(input => input.required && !values[input.name]?.trim()).map(input => input.name) ?? [];
    if (missing.length) { setError("Fill in " + missing.join(", ") + "."); return; }
    try { setPreview(await api.prepare(copyId, {kind: "dispatch", workflowId, ref: ref.trim(), inputs: spec ? dispatchValues(spec, values) : {}})); }
    catch (cause) { setError(message(cause)); }
  };
  const field = (input: DispatchInput) => {
    const value = values[input.name] ?? "";
    const set = (next: string) => setValues(current => ({...current, [input.name]: next}));
    if (input.type === "boolean") return <input type="checkbox" checked={value === "true"} onChange={event => set(String(event.target.checked))}/>;
    if (input.type === "choice") return <select value={value} onChange={event => set(event.target.value)}>
      {input.options.map(option => <option key={option} value={option}>{option}</option>)}</select>;
    return <input value={value} inputMode={input.type === "number" ? "decimal" : undefined} onChange={event => set(event.target.value)}/>;
  };
  return <form className="git-stack git-ci-dispatch" onSubmit={submit} aria-label="Run workflow">
    <div className="git-row git-ci-run-title"><h3>Run workflow</h3><button type="button" onClick={onClose}>Close</button></div>
    {!workflows && !error && <p className="git-muted" role="status">Loading workflows…</p>}
    {workflows?.length === 0 && <p className="git-muted">This repository has no workflows.</p>}
    {workflows && workflows.length > 0 && <>
      <label>Workflow<select value={workflowId} onChange={event => setWorkflowId(event.target.value)}>
        {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>
      <label>Branch or tag<input value={ref} onChange={event => setRef(event.target.value)} required maxLength={250}/></label>
      {!spec && ref.trim() && !error && <p className="git-muted" role="status">Reading the workflow…</p>}
      {spec && !spec.dispatchable && <p className="git-muted">This workflow has no manual trigger.</p>}
      {spec?.dispatchable && inputsLimitation && <p className="git-muted">{inputsLimitation}</p>}
      {spec?.dispatchable && spec.inputs.map(input => <label key={input.name} className={input.type === "boolean" ? "git-ci-check" : undefined}>
        <span>{input.name}{input.required ? " *" : ""}{input.description ? <span className="git-muted"> — {input.description}</span> : null}</span>
        {field(input)}</label>)}
      <div className="git-row"><button type="submit" className="git-primary" disabled={!spec?.dispatchable}>Run workflow</button></div>
    </>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {preview && <ConfirmDialog title="Run workflow" lines={preview.lines} onConfirm={() => api.confirm(preview.id)}
      onClose={done => { setPreview(undefined); if (done) onDone(); }}/>}
  </form>;
}
