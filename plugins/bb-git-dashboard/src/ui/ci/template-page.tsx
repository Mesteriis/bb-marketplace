import { useEffect, useMemo, useState, type FormEvent } from "react";
import { templateDefaults } from "../../core/ci-templates/catalog.ts";
import type { CiTemplatesView } from "../../core/ci-templates/contract.ts";
import { renderTemplate, resolveValues, secretIssues, type CiValues } from "../../core/ci-templates/render.ts";
import { CodedError } from "../../core/workspace.ts";
import { message, type CiApi } from "./ci-api.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { ParamField } from "../templating/param-field.tsx";

type Offered = CiTemplatesView["offered"][number];
const stackNames: Record<string, string> = {node: "Node.js", python: "Python", go: "Go", rust: "Rust", docker: "Docker"};
const sourceNames = {builtin: "Built-in", settings: "Settings", folder: "Folder"} as const;
const forgeNames = {github: "GitHub Actions", gitea: "Gitea Actions", gitlab: "GitLab CI", azure: "Azure Pipelines"} as const;

/** The form of one template: its values, the new branch and pull request, and the file as it will be written. */
function TemplateForm({api, copyId, view, entry, onDone}: {api: CiApi; copyId: string; view: CiTemplatesView; entry: Offered;
  onDone(outcome: string): void}) {
  const {template} = entry;
  const suggested = useMemo(() => templateDefaults(template, view.stacks, view.repo), [template, view]);
  const [values, setValues] = useState<CiValues>(() => resolveValues(template, {}, suggested));
  const [branch, setBranch] = useState("ci/" + template.id);
  const [title, setTitle] = useState("Add CI: " + template.title);
  const [body, setBody] = useState("Adds a CI pipeline from the Makosh Git template “" + template.title + "”. Review it before merging.");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<Awaited<ReturnType<CiApi["prepareTemplate"]>> | null>(null);
  // The same render the server makes: a value that does not fit shows here before anything is sent.
  const rendered = useMemo(() => {
    try {
      const file = renderTemplate(template, resolveValues(template, values, {}));
      const issues = secretIssues(file.path + "\n" + file.text);
      return issues.length ? {problem: "The file would have " + issues.join(", ") + "."} : {file};
    } catch (cause) { return {problem: cause instanceof CodedError ? "Check the values: " + cause.detail + "." : message(cause)}; }
  }, [template, values]);
  const existing = "file" in rendered && rendered.file ? view.existing.includes(rendered.file.path) : false;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try { setPrepared(await api.prepareTemplate({copyId, key: entry.key, values, branch: branch.trim(), title, body})); }
    catch (cause) { setError(message(cause)); }
  };
  return <form className="git-stack git-ci-dispatch" aria-label={"Template " + template.title} onSubmit={submit}>
    <div className="git-row git-ci-run-title"><h3>{template.title}</h3><span className="git-muted">{sourceNames[entry.source]}</span></div>
    {template.description && <p className="git-muted">{template.description}</p>}
    {view.forge === "github" && <p className="git-muted">GitHub accepts a workflow file only from a token with the workflow scope.</p>}
    {template.params.map(param => <ParamField key={param.name} param={param} value={values[param.name] ?? param.default}
      onChange={value => setValues(previous => ({...previous, [param.name]: value}))}/>)}
    <label>New branch<input value={branch} required maxLength={250} pattern="[A-Za-z0-9_][A-Za-z0-9_.\/\-]*" onChange={event => setBranch(event.target.value)}/></label>
    <label>Pull request title<input value={title} required maxLength={220} onChange={event => setTitle(event.target.value)}/></label>
    <label>Pull request description<textarea rows={3} maxLength={4000} value={body} onChange={event => setBody(event.target.value)}/></label>
    {"problem" in rendered ? <p className="git-error" role="alert">{rendered.problem}</p> : <>
      <div className="git-row"><strong className="git-path">{rendered.file.path}</strong>
        <span className="git-muted">{rendered.file.text.split("\n").filter(Boolean).length} lines, in a new branch from {view.repo.branch ?? "the default branch"} at the forge</span></div>
      {existing && <p className="git-error" role="alert">{view.ref} already has {rendered.file.path}: the forge will refuse a new file there. Change the file name, or edit that file instead.</p>}
      <pre className="git-code" aria-label="File preview">{rendered.file.text}</pre>
    </>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="git-row"><button type="submit" className="git-primary" disabled={"problem" in rendered || existing}>Create branch and pull request…</button></div>
    {prepared && <ConfirmDialog title="Create CI branch and pull request" lines={prepared.preview.lines} onClose={() => setPrepared(null)}
      onConfirm={async () => {
        // The preview is spent once publish runs: whatever the outcome, the dialog closes and the form says it.
        try {
          const outcome = await api.publishTemplate(prepared.preview.id);
          const left = outcome.summary.filter(line => line.startsWith("Branch " + branch.trim() + " was created"));
          if (outcome.status === "failed" || outcome.status === "unknown")
            setError((outcome.status === "unknown" ? "The outcome is unknown (" : "Not done (") + (outcome.code ?? "OUTCOME_UNKNOWN") + ")." + (left.length ? " " + left.join(" ") : " Nothing was left on the forge."));
          else onDone(outcome.pullNumber ? "Pull request #" + outcome.pullNumber + " opened from " + branch.trim() + "." : "The branch " + branch.trim() + " was created.");
        } catch (cause) { setError(message(cause)); }
      }}>
      <pre className="git-code" aria-label="File to commit">{prepared.file.text}</pre>
    </ConfirmDialog>}
  </form>;
}

/**
 * CI templates for the linked repository's forge: the stack read at HEAD, the templates that suit it first, and a
 * chosen one written to a new branch with a pull request after confirmation.
 */
export function TemplatePage({api, copyId, onClose}: {api: CiApi; copyId: string; onClose(): void}) {
  const [view, setView] = useState<CiTemplatesView | null>(null);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [done, setDone] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    api.templates(copyId).then(result => {
      if (!live) return;
      setView(result);
      setKey(previous => result.offered.some(item => item.key === previous) ? previous : result.offered[0]?.key ?? "");
    }, cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [api, copyId, revision]);
  const entry = view?.offered.find(item => item.key === key);
  const suggested = view?.offered.filter(item => item.matches) ?? [];
  const others = view?.offered.filter(item => !item.matches) ?? [];
  return <section className="git-stack git-ci" aria-label="CI templates">
    <div className="git-row git-ci-toolbar"><h3>CI templates{view ? " · " + forgeNames[view.forge] : ""}</h3><span className="git-ci-spacer"/>
      <button type="button" onClick={onClose}>Back to runs</button></div>
    {!view && !error && <p className="git-muted" role="status">Reading the project…</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {done && <p role="status">{done}</p>}
    {view && <>
      <p className="git-muted">{view.head === null ? "The copy has no commits yet."
        : view.stacks.length ? "Found at " + view.ref + ": " + view.stacks.map(stack => stackNames[stack.id] + " (" + stack.evidence.join(", ") + ")").join("; ") + "."
        : "No known stack at the root of " + view.ref + ": every template is listed."}
        {view.ref === "HEAD" && view.head !== null && " The copy has no fetched origin/" + (view.repo.branch ?? "default branch") + ", so its current branch was read."}</p>
      {view.existing.length > 0 && <p className="git-muted">CI files already there: {view.existing.join(", ")}.</p>}
      {view.rejected.length > 0 && <details><summary>{view.rejected.length} own template(s) not offered</summary>
        <ul>{view.rejected.map(item => <li key={item.source + item.name}><strong>{item.name}</strong> ({sourceNames[item.source]}): {item.issues.join(" ")}</li>)}</ul></details>}
      {view.offered.length === 0 ? <p className="git-muted">No templates for this forge.</p>
        : <label className="git-ci-template-pick">Template<select value={key} onChange={event => { setKey(event.target.value); setDone(""); }}>
          {suggested.length > 0 && <optgroup label="Suited to this project">{suggested.map(item => <option key={item.key} value={item.key}>{item.template.title}</option>)}</optgroup>}
          {others.length > 0 && <optgroup label={suggested.length ? "Other stacks" : "All templates"}>{others.map(item => <option key={item.key} value={item.key}>{item.template.title}</option>)}</optgroup>}
        </select></label>}
      {entry && <TemplateForm key={entry.key + "#" + revision} api={api} copyId={copyId} view={view} entry={entry}
        onDone={text => { setDone(text); setRevision(value => value + 1); }}/>}
    </>}
  </section>;
}
