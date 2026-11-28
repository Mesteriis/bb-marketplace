import { useEffect, useMemo, useState } from "react";
import { dispatchValues, workflowOf, type DispatchInput, type DispatchSpec } from "../../core/ci/dispatch.ts";
import type { Workflow } from "../../core/ci/pipelines.ts";
import { useT } from "../i18n/use-t.tsx";
import { Dialog } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";
import { message, type CiApi } from "./ci-api.ts";

function initialValues(inputs: DispatchInput[]) {
  return Object.fromEntries(inputs.map(input => [input.name, input.default ?? (input.type === "boolean" ? "false" : input.type === "choice" ? input.options[0] ?? "" : "")]));
}

/** A pause after the last change before the server is asked for its preview: typing does not spend previews. */
const settle = 700;

/**
 * Runs a workflow by hand: the workflow, the branch and the inputs its manual trigger declares, then what the server
 * will send, read from its own preview, and one Run that sends exactly that preview. A change prepares a new one.
 */
export function DispatchDialog({api, copyId, inputsLimitation, onClose, onDone, initialWorkflow = null, initialRef = null}: {
  api: CiApi; copyId: string; inputsLimitation: string | null; onClose(): void; onDone(): void;
  /** Preselected from a run: its workflow and branch; a workflow no longer listed falls back to the first one. */
  initialWorkflow?: string | null; initialRef?: string | null;
}) {
  const t = useT();
  const [workflows, setWorkflows] = useState<Workflow[]>();
  const [workflowId, setWorkflowId] = useState("");
  const [ref, setRef] = useState("");
  const [spec, setSpec] = useState<DispatchSpec>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{id: string; lines: string[]; key: string; expires: number}>();
  const [running, setRunning] = useState(false);
  // Asks again for the same values: after a refused Run, a failed preview, or one that outlived its five minutes.
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    api.workflows(copyId).then(result => {
      if (!active) return;
      setWorkflows(result.workflows);
      setWorkflowId(workflowOf(result.workflows, initialWorkflow)?.id ?? result.workflows[0]?.id ?? "");
      setRef(initialRef ?? result.defaultBranch ?? "");
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, initialWorkflow, initialRef]);
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
  const missing = spec?.inputs.filter(input => input.required && !values[input.name]?.trim()).map(input => input.name) ?? [];
  const action = useMemo(() => spec?.dispatchable && !missing.length && ref.trim()
    ? {kind: "dispatch" as const, workflowId, ref: ref.trim(), inputs: dispatchValues(spec, values)} : null,
  // `missing` follows from spec and values.
  [spec, values, workflowId, ref]);
  const key = action ? JSON.stringify(action) : "";
  // The server's preview of the current choice, asked once the form rests; Run sends only a preview of what is shown.
  useEffect(() => {
    if (!action) return;
    let active = true;
    setPreview(undefined);
    const timer = setTimeout(() => api.prepare(copyId, action).then(result => {
      if (active) { setPreview({id: result.id, lines: result.lines, key, expires: Date.parse(result.expires)}); setError(""); }
    }, cause => { if (active) setError(message(cause)); }), settle);
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, key, attempt]);
  // A preview the server has let go is no longer shown as what Run sends.
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, preview.expires - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [preview]);
  const current = preview && preview.key === key && preview.expires > now ? preview : null;
  const stale = !!action && !current && !!preview && preview.key === key;
  const run = async () => {
    if (!current) { setError(""); setAttempt(value => value + 1); return; }
    setRunning(true);
    setError("");
    try { await api.confirm(current.id); onDone(); }
    catch (cause) { setError(message(cause)); setPreview(undefined); setRunning(false); setAttempt(value => value + 1); }
  };
  const field = (input: DispatchInput, id: string) => {
    const value = values[input.name] ?? "";
    const set = (next: string) => setValues(previous => ({...previous, [input.name]: next}));
    if (input.type === "boolean") return <button type="button" role="switch" id={id} className="g-tog" aria-checked={value === "true"}
      aria-label={input.name} onClick={() => set(value === "true" ? "false" : "true")}/>;
    if (input.type === "choice") return <select id={id} className="g-inp" value={value} onChange={event => set(event.target.value)}>
      {input.options.map(option => <option key={option} value={option}>{option}</option>)}</select>;
    return <input id={id} className="g-inp" value={value} inputMode={input.type === "number" ? "decimal" : undefined} onChange={event => set(event.target.value)}/>;
  };
  return <Dialog title={t("ci.dispatch.title")} busy={running} onClose={onClose} actions={<>
    <button type="button" className="g-btn" disabled={running} onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" className="g-btn pri" disabled={!action || running || (!current && !stale && !error)}
      title={!current && action ? t(stale || error ? "ci.dispatch.again" : "ci.dispatch.preparing") : undefined}
      onClick={() => void run()}><Icon name="Play" small/>{running ? t("ci.working") : t("ci.dispatch.run")}</button>
  </>}>
    <div className="git-ci-dispatch" role="form" aria-label={t("ci.dispatch.title")}>
      {!workflows && !error && <p className="g-muted" role="status">{t("ci.dispatch.loading")}</p>}
      {workflows?.length === 0 && <p className="g-muted">{t("ci.dispatch.none")}</p>}
      {workflows && workflows.length > 0 && <>
        <label>{t("ci.dispatch.workflow")}<select className="g-inp" value={workflowId} onChange={event => setWorkflowId(event.target.value)}>
          {workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name + (workflow.path ? " · " + workflow.path : "")}</option>)}</select></label>
        <label>{t("ci.dispatch.ref")}<input className="g-inp" value={ref} onChange={event => setRef(event.target.value)} required maxLength={250}/></label>
        {!spec && ref.trim() && !error && <p className="g-muted" role="status">{t("ci.dispatch.reading")}</p>}
        {spec && !spec.dispatchable && <p className="g-muted">{t("ci.dispatch.manual-off")}</p>}
        {spec?.dispatchable && inputsLimitation && <p className="g-muted">{inputsLimitation}</p>}
        {spec?.dispatchable && spec.inputs.length > 0 && <h3 className="g-sec">{t("ci.dispatch.inputs")}</h3>}
        {spec?.dispatchable && spec.inputs.map(input => {
          const id = "git-ci-input-" + input.name;
          const name = <>{input.name}{input.required ? " *" : ""}{input.description ? " · " + input.description : ""}</>;
          return input.type === "boolean"
            ? <div key={input.name} className="git-ci-switch">{field(input, id)}<label htmlFor={id}>{name}</label></div>
            : <label key={input.name} htmlFor={id}>{name}{field(input, id)}</label>;
        })}
        {missing.length > 0 && <p className="g-muted">{t("ci.dispatch.fill", {names: missing.join(", ")})}</p>}
        {action && <div className="git-ci-sends" role="status" aria-label={t("ci.dispatch.will-send")}>
          <Icon name="Info" small/>
          {current ? <ul className="git-ci-lines">{current.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
            : <span className="g-muted">{t(stale ? "ci.dispatch.expired" : error ? "ci.dispatch.again" : "ci.dispatch.preparing")}</span>}
        </div>}
      </>}
      {error && <p className="git-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
