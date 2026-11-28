import { useEffect, useMemo, useState, type FormEvent } from "react";
import { templateDefaults } from "../../core/ci-templates/catalog.ts";
import type { CiTemplatesView } from "../../core/ci-templates/contract.ts";
import { renderTemplate, resolveValues, secretIssues, type CiValues } from "../../core/ci-templates/render.ts";
import { CodedError } from "../../core/workspace.ts";
import { message, type CiApi } from "./ci-api.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { ParamField } from "../templating/param-field.tsx";

type Offered = CiTemplatesView["offered"][number];
const sourceKeys = {builtin: "ci.tpl.builtin", settings: "ci.tpl.src-settings", folder: "ci.tpl.src-folder"} as const;
const stackNames: Record<string, string> = {node: "Node.js", python: "Python", go: "Go", rust: "Rust", docker: "Docker"};
const forgeNames = {github: "GitHub Actions", gitea: "Gitea Actions", gitlab: "GitLab CI", azure: "Azure Pipelines"} as const;

/**
 * One template in two columns: its values and where it goes (the new branch and pull request), then the file as it
 * will be written, with its lines numbered, what will happen, and the one main action.
 */
function TemplateForm({api, copyId, view, entry, onDone}: {api: CiApi; copyId: string; view: CiTemplatesView; entry: Offered;
  onDone(outcome: string): void}) {
  const t = useT();
  const {template} = entry;
  const suggested = useMemo(() => templateDefaults(template, view.stacks, view.repo), [template, view]);
  const [values, setValues] = useState<CiValues>(() => resolveValues(template, {}, suggested));
  const [branch, setBranch] = useState("ci/" + template.id);
  const [title, setTitle] = useState(t("ci.tpl.pr-title", {name: template.title}));
  const [body, setBody] = useState(t("ci.tpl.pr-body", {name: template.title}));
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<Awaited<ReturnType<CiApi["prepareTemplate"]>> | null>(null);
  // The same render the server makes: a value that does not fit shows here before anything is sent.
  const rendered = useMemo(() => {
    try {
      const file = renderTemplate(template, resolveValues(template, values, {}));
      const issues = secretIssues(file.path + "\n" + file.text);
      return issues.length ? {problem: t("ci.tpl.secrets", {what: issues.join(", ")})} : {file};
    } catch (cause) { return {problem: cause instanceof CodedError ? t("ci.tpl.check", {detail: cause.detail}) : message(cause)}; }
  }, [template, values, t]);
  const existing = "file" in rendered && rendered.file ? view.existing.includes(rendered.file.path) : false;
  const lines = "file" in rendered && rendered.file ? rendered.file.text.replace(/\n$/, "").split("\n") : [];
  const base = view.repo.branch ?? t("ci.tpl.default-branch");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try { setPrepared(await api.prepareTemplate({copyId, key: entry.key, values, branch: branch.trim(), title, body})); }
    catch (cause) { setError(message(cause)); }
  };
  return <form className="git-ci-tpl-work" aria-label={t("ci.tpl.form", {name: template.title})} onSubmit={submit}>
    <section className="git-ci-tpl-form" aria-label={t("ci.tpl.values")}>
      {template.description && <p className="g-muted">{template.description}</p>}
      {view.forge === "github" && <p className="g-muted">{t("ci.tpl.github-scope")}</p>}
      {template.params.map(param => <ParamField key={param.name} param={param} value={values[param.name] ?? param.default}
        onChange={value => setValues(previous => ({...previous, [param.name]: value}))}/>)}
      <h3 className="g-sec">{t("ci.tpl.where")}</h3>
      <label>{t("ci.tpl.branch")}<input className="g-inp" value={branch} required maxLength={250} pattern="[A-Za-z0-9_][A-Za-z0-9_.\/\-]*" onChange={event => setBranch(event.target.value)}/></label>
      <label>{t("ci.tpl.title")}<input className="g-inp" value={title} required maxLength={220} onChange={event => setTitle(event.target.value)}/></label>
      <label>{t("ci.tpl.body")}<textarea className="g-inp" rows={3} maxLength={4000} value={body} onChange={event => setBody(event.target.value)}/></label>
    </section>
    <section className="git-ci-tpl-preview" aria-label={t("ci.tpl.preview")}>
      {"problem" in rendered ? <div className="g-banner bad" role="alert">{rendered.problem}</div> : <>
        <div className="git-ci-tpl-file"><span className="g-sec">{t("ci.tpl.preview")}</span><code className="git-path">{rendered.file.path}</code>
          <span className="g-muted g-num">{t("ci.tpl.lines", {n: lines.length})}</span></div>
        {existing && <div className="g-banner bad" role="alert">{t("ci.tpl.exists", {ref: view.ref, path: rendered.file.path})}</div>}
        <pre className="git-ci-tpl-code" aria-label={t("ci.tpl.file-preview")}>{lines.map((line, index) =>
          <span key={index} className="git-ci-line"><span className="git-ci-number" aria-hidden="true">{index + 1}</span>{line + "\n"}</span>)}</pre>
        <p className="g-muted">{t("ci.tpl.safe")}</p>
        <div className="git-ci-sends"><Icon name="GitBranch" small/><span>{t("ci.tpl.will", {branch: branch.trim() || "—", base})}</span></div>
      </>}
      {error && <div className="g-banner bad" role="alert">{error}</div>}
      <div><button type="submit" className="g-btn pri" disabled={"problem" in rendered || existing}><Icon name="GitPullRequest" small/>{t("ci.tpl.create")}</button></div>
    </section>
    {prepared && <ConfirmDialog title={t("ci.tpl.confirm")} lines={prepared.preview.lines} onClose={() => setPrepared(null)}
      onConfirm={async () => {
        // The preview is spent once publish runs: whatever the outcome, the dialog closes and the form says it.
        try {
          const outcome = await api.publishTemplate(prepared.preview.id);
          const left = outcome.summary.filter(line => line.startsWith("Branch " + branch.trim() + " was created"));
          if (outcome.status === "failed" || outcome.status === "unknown")
            setError(t(outcome.status === "unknown" ? "ci.tpl.unknown" : "ci.tpl.not-done", {code: outcome.code ?? "OUTCOME_UNKNOWN"}) + " " + (left.length ? left.join(" ") : t("ci.tpl.nothing-left")));
          else onDone(outcome.pullNumber ? t("ci.tpl.opened", {n: outcome.pullNumber, branch: branch.trim()}) : t("ci.tpl.branch-made", {branch: branch.trim()}));
        } catch (cause) { setError(message(cause)); }
      }}>
      <pre className="git-code" aria-label={t("ci.tpl.file-commit")}>{prepared.file.text}</pre>
    </ConfirmDialog>}
  </form>;
}

/**
 * CI templates for the linked repository's forge: the stack read at HEAD, the templates in a list (built-in, then
 * your own; the ones that suit the stack marked, the refused ones with their reason), the chosen one's form and file.
 */
export function TemplatePage({api, copyId, onClose}: {api: CiApi; copyId: string; onClose(): void}) {
  const t = useT();
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
      setKey(previous => result.offered.some(item => item.key === previous) ? previous
        : (result.offered.find(item => item.matches) ?? result.offered[0])?.key ?? "");
    }, cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [api, copyId, revision]);
  const entry = view?.offered.find(item => item.key === key);
  const builtIn = view?.offered.filter(item => item.source === "builtin") ?? [];
  const own = view?.offered.filter(item => item.source !== "builtin") ?? [];
  const found = !view ? "" : view.head === null ? t("ci.tpl.no-commits")
    : view.stacks.length ? t("ci.tpl.found", {ref: view.ref, stacks: view.stacks.map(stack => stackNames[stack.id] + " (" + stack.evidence.join(", ") + ")").join("; ")})
    : t("ci.tpl.no-stack", {ref: view.ref});
  const item = (offered: Offered) => <li key={offered.key}><button type="button" aria-current={offered.key === key ? "true" : undefined}
    onClick={() => { setKey(offered.key); setDone(""); }}><Icon name="File" small/><span className="git-ci-tpl-name" title={offered.template.title}>{offered.template.title.replace(" · " + forgeNames[view!.forge], "")}</span>
    {offered.matches && <span className="g-chip good">{t("ci.tpl.fits")}</span>}
    {offered.source !== "builtin" && <span className="g-muted git-ci-tpl-src">{t(sourceKeys[offered.source])}</span>}</button></li>;
  return <section className="git-ci git-ci-templates" aria-label={t("ci.tpl.page")}>
    <div className="git-ci-tpl-head">
      <h2>{t("ci.tpl.page")}{view ? " · " + forgeNames[view.forge] : ""}</h2>
      {view && <span className="g-muted">{found}{view.ref === "HEAD" && view.head !== null ? " " + t("ci.tpl.head-read", {branch: view.repo.branch ?? "—"}) : ""}</span>}
      <button type="button" className="g-btn git-ci-end" onClick={onClose}><Icon name="ArrowLeft" small/>{t("ci.tpl.back")}</button>
    </div>
    {!view && !error && <p className="g-state-page" role="status">{t("ci.tpl.reading")}</p>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {done && <div className="g-banner" role="status">{done}</div>}
    {view && view.existing.length > 0 && <p className="git-ci-status g-muted">{t("ci.tpl.existing", {files: view.existing.join(", ")})}</p>}
    {view && <div className="git-ci-tpl-grid">
      <nav className="git-ci-tpl-list" aria-label={t("ci.tpl.list")}>
        {view.offered.length === 0 && <p className="g-muted">{t("ci.tpl.none")}</p>}
        {builtIn.length > 0 && <><h3 className="g-sec">{t("ci.tpl.builtin")}</h3><ul>{builtIn.map(item)}</ul></>}
        {(own.length > 0 || view.rejected.length > 0) && <><h3 className="g-sec">{t("ci.tpl.own")}</h3><ul>{own.map(item)}
          {view.rejected.map(refused => <li key={refused.source + refused.name} className="git-ci-tpl-refused" title={refused.issues.join(" ")}>
            <Icon name="AlertTriangle" small/><span className="git-ci-tpl-name">{refused.name}</span><span className="g-muted">{t("ci.tpl.unfit")}</span>
            <small className="git-ci-tpl-why">{t(sourceKeys[refused.source])} · {refused.issues.join(" ")}</small></li>)}</ul></>}
      </nav>
      {entry && <TemplateForm key={entry.key + "#" + revision} api={api} copyId={copyId} view={view} entry={entry}
        onDone={text => { setDone(text); setRevision(value => value + 1); }}/>}
    </div>}
  </section>;
}
