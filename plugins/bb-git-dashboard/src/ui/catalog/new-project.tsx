import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { clonePath } from "../../core/catalog/catalog.ts";
import { homeRelative } from "../../core/short-path.ts";
import type { CiForge } from "../../core/ci-templates/render.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { scaffoldCi } from "../../core/scaffolds/ci.ts";
import type { ScaffoldsView } from "../../core/scaffolds/contract.ts";
import { scaffoldLabelKey } from "../../core/scaffolds/labels.ts";
import { buildScaffold } from "../../core/scaffolds/model.ts";
import { commonParams } from "../../core/scaffolds/overlay.ts";
import { validOwner } from "../../core/scaffolds/repository.ts";
import type { TemplateParam, TemplateValues } from "../../core/templating/engine.ts";
import { CodedError } from "../../core/workspace.ts";
import { message } from "../ci/ci-api.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import type { CatalogApi } from "./catalog-api.ts";

type Offered = ScaffoldsView["offered"][number];
type T = ReturnType<typeof useT>;
const forges: [CiForge | "", string][] = [["github", "GitHub"], ["gitlab", "GitLab"], ["gitea", "Gitea"], ["azure", "Azure"], ["", ""]];
const sourceKey = {builtin: "np.src.builtin", settings: "np.src.settings", folder: "np.src.folder"} as const;
/** The common values every scaffold asks for: their labels are the plugin's own, so they are said in the chosen language. */
const commonLabel = (name: string): MessageKey | null => commonParams.some(param => param.name === name) ? ("np.p." + name) as MessageKey : null;
type Created = Awaited<ReturnType<CatalogApi["createScaffold"]>>;

function Field({label, children}: {label: string; children: ReactNode}) {
  return <label className="git-np-field"><span>{label}</span>{children}</label>;
}

/** One scaffold parameter: a short list as a segment, a longer one as a select, a flag as a checkbox, else a field. */
function Param({scaffold, param, value, onChange, t}: {scaffold: string; param: TemplateParam; value: string | boolean; onChange(value: string | boolean): void; t: T}) {
  // The common values and the plugin's own scaffolds are labelled in the chosen language; an owner's scaffold as written.
  const own = commonLabel(param.name) ?? scaffoldLabelKey(scaffold, param.name);
  const label = own ? t(own) : param.label;
  if (param.kind === "flag") return <label className="git-np-check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)}/>
    <span>{label}</span></label>;
  if (param.kind === "choice" && param.choices.length <= 4) return <div className="git-np-field" role="group" aria-label={label}><span>{label}</span>
    <div className="g-seg">{param.choices.map(choice => <button key={choice} type="button" aria-pressed={String(value) === choice} onClick={() => onChange(choice)}>
      {param.name === "license" && choice === "none" ? t("np.no-license") : choice}</button>)}</div></div>;
  if (param.kind === "choice") return <Field label={label}><select className="g-inp" value={String(value)} onChange={event => onChange(event.target.value)}>
    {param.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select></Field>;
  return <Field label={label}><input className="g-inp" value={String(value)} maxLength={param.kind === "line" ? 200 : 100} onChange={event => onChange(event.target.value)}/></Field>;
}

/**
 * The form of one scaffold in three columns: where the project goes and its values, CI, author and repository; the files
 * as they will be written; the chosen file's text. "Check project…" asks the server for the preview, confirmed in a dialog.
 */
function ScaffoldForm({api, hostId, root, categories, entry, suggested, accounts, onCreated, picker}: {api: CatalogApi; hostId: string; root: string;
  categories: string[]; entry: Offered; suggested: TemplateValues; accounts: ScaffoldsView["accounts"]; onCreated(made: Created): void; picker: ReactNode}) {
  const t = useT();
  const params = useMemo(() => [...commonParams, ...entry.scaffold.params], [entry]);
  const [values, setValues] = useState<TemplateValues>(() => Object.fromEntries(params.map(param => [param.name, suggested[param.name] ?? param.default])));
  const [category, setCategory] = useState(categories.includes("") ? "" : categories[0] ?? "");
  const [forge, setForge] = useState<CiForge | "">("github");
  const [author, setAuthor] = useState({name: "", email: ""});
  // A repository on a forge: off unless asked for, private unless public is chosen.
  const [remote, setRemote] = useState({on: false, accountId: accounts[0]?.id ?? "", owner: "", visibility: "private" as "private" | "public"});
  const account = accounts.find(item => item.id === remote.accountId);
  const ownerReady = !remote.on || (account !== undefined && (account.kind !== "azure" || remote.owner.trim() !== "") && validOwner(account.kind, remote.owner.trim() || null));
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<{id: string; lines: string[]; files: {path: string; bytes: number}[]} | null>(null);
  // The same build the server makes, so a value that does not fit shows before anything is sent.
  const built = useMemo(() => {
    try {
      const {files} = buildScaffold(entry.scaffold, values, suggested);
      const ci = scaffoldCi(files, entry.scaffold, forge || null, {name: String(values.name), branch: "main"});
      const all = ci ? [...files.filter(file => file.path !== ci.path), {path: ci.path, text: ci.text, executable: false}].sort((a, b) => a.path < b.path ? -1 : 1) : files;
      return {ok: true as const, files: all, ci};
    } catch (cause) { return {ok: false as const, problem: cause instanceof CodedError ? t("np.check-values", {detail: cause.detail ?? ""}) : message(cause)}; }
  }, [entry, values, suggested, forge, t]);
  const destination = clonePath(root, category, String(values.name));
  const authorReady = author.name.trim() !== "" && /^[^\s@<>]+@[^\s@<>]+$/.test(author.email.trim());
  const file = built.ok ? built.files.find(item => item.path === shown) ?? built.files.find(item => item.path === "README.md") ?? built.files[0] : undefined;
  const lines = file ? (file.text.endsWith("\n") ? file.text.slice(0, -1) : file.text).split("\n") : [];
  const set = (name: string) => (value: string | boolean) => setValues(previous => ({...previous, [name]: value}));
  const param = (item: TemplateParam) => <Param key={item.name} scaffold={entry.scaffold.id} param={item} value={values[item.name] ?? item.default} onChange={set(item.name)} t={t}/>;
  const common = (name: string) => params.find(item => item.name === name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true); setError("");
    api.prepareScaffold({hostId, key: entry.key, values, category, ciForge: forge || null, author: {name: author.name.trim(), email: author.email.trim()},
      repository: remote.on && account ? {accountId: account.id, owner: remote.owner.trim() || null, visibility: remote.visibility} : null})
      .then(setPreview, failure => setError(message(failure))).finally(() => setPending(false));
  };
  const nameParam = common("name");
  return <div className="git-np">
    <form id="git-np-form" className="git-np-form" aria-label={t("np.form", {title: entry.scaffold.title})} onSubmit={submit}>
      {picker}
      {entry.scaffold.description && <p className="g-muted git-np-about">{entry.scaffold.description}</p>}
      <div className="git-np-field" role="group" aria-label={t("np.category")}><span>{t("np.category")}</span>
        <div className="g-seg git-np-wrap">{categories.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>
          {value || t("ct.category-root")}</button>)}</div></div>
      {nameParam && <Field label={t("np.folder")}><input className="g-inp" value={String(values.name ?? "")} maxLength={100} onChange={event => set("name")(event.target.value)}/></Field>}
      {entry.scaffold.params.length > 0 && <><h3 className="git-np-group">{t("np.scaffold-params")}</h3>{entry.scaffold.params.map(param)}</>}
      <h3 className="git-np-group">{t("np.common")}</h3>
      {commonParams.filter(item => item.name !== "name").map(item => param(params.find(own => own.name === item.name) ?? item))}
      <div className="git-np-field" role="group" aria-label="CI"><span>CI</span>
        <div className="g-seg git-np-wrap">{forges.map(([value, label]) => <button key={value || "none"} type="button" aria-pressed={forge === value} onClick={() => setForge(value)}>
          {value ? label : t("np.no-ci")}</button>)}</div></div>
      <h3 className="git-np-group">{t("np.author")}</h3>
      <div className="git-np-pair">
        <Field label={t("np.author-name")}><input className="g-inp" value={author.name} maxLength={200} onChange={event => setAuthor(previous => ({...previous, name: event.target.value}))}/></Field>
        <Field label={t("np.email")}><input className="g-inp" value={author.email} maxLength={200} type="email" placeholder="name@example.org" onChange={event => setAuthor(previous => ({...previous, email: event.target.value}))}/></Field>
      </div>
      {accounts.length > 0 && <>
        <h3 className="git-np-group">{t("np.repository")}</h3>
        <label className="git-np-check"><input type="checkbox" checked={remote.on} onChange={event => {
          setRemote(previous => ({...previous, on: event.target.checked}));
          // The CI follows the repository's forge.
          if (event.target.checked && account) setForge(account.kind);
        }}/><span>{t("np.repository-on")}</span></label>
        {remote.on && <>
          <Field label={t("np.account")}><select className="g-inp" value={remote.accountId} onChange={event => {
            const next = accounts.find(item => item.id === event.target.value);
            setRemote(previous => ({...previous, accountId: event.target.value}));
            if (next) setForge(next.kind);
          }}>{accounts.map(item => <option key={item.id} value={item.id}>{item.label} ({item.kind})</option>)}</select></Field>
          <div className="git-np-pair">
            <Field label={account?.kind === "azure" ? t("np.azure-project") : t("np.owner", {user: account?.username ?? "—"})}>
              <input className="g-inp" value={remote.owner} maxLength={255} placeholder={t(account?.kind === "gitlab" ? "np.owner-gitlab" : account?.kind === "azure" ? "np.azure-placeholder" : "np.owner-placeholder")}
                onChange={event => setRemote(previous => ({...previous, owner: event.target.value}))}/></Field>
            <div className="git-np-field" role="group" aria-label={t("np.visibility")}><span>{account?.kind === "azure" ? t("np.visibility-azure") : t("np.visibility")}</span>
              <div className="g-seg">{(["private", "public"] as const).map(value => <button key={value} type="button" aria-pressed={remote.visibility === value}
                onClick={() => setRemote(previous => ({...previous, visibility: value}))}>{t(value === "private" ? "np.private" : "np.public")}</button>)}</div></div>
          </div>
          {remote.visibility === "public" && <div className="g-banner bad git-np-note" role="alert">{t("np.public-warning")}</div>}
          {!ownerReady && <p className="g-muted">{account?.kind === "azure" ? t("np.owner-azure") : t("np.owner-hint")}</p>}
        </>}
      </>}
    </form>
    <section className="git-np-files" aria-labelledby="git-np-files-title">
      <h3 id="git-np-files-title" className="git-np-group">{t("np.files")} <span className="g-num g-muted">{built.ok ? built.files.length : ""}</span></h3>
      {!built.ok ? <div className="g-banner bad git-np-note" role="alert">{built.problem}</div>
        : <ul aria-label={t("np.files")}>{built.files.map(item => {
          const slash = item.path.lastIndexOf("/");
          return <li key={item.path}><button type="button" aria-pressed={file?.path === item.path} onClick={() => setShown(item.path)}>
            <Icon name="File" small/><span className="git-np-path"><span className="g-muted">{item.path.slice(0, slash + 1)}</span>{item.path.slice(slash + 1)}</span></button></li>;
        })}</ul>}
    </section>
    <section className="git-np-content" aria-labelledby="git-np-content-title">
      <div className="git-np-content-head"><h3 id="git-np-content-title" className="git-np-group">{t("np.content")} <span className="g-mono">{file?.path ?? ""}</span></h3>
        {file && <span className="g-muted">{t("np.lines", {n: lines.length})}</span>}</div>
      {file && <pre className="git-np-code" aria-label={t("np.content-of", {path: file.path})}>{file.text ? lines.map((line, index) =>
        <span key={index} className="git-np-line"><span className="git-np-number" aria-hidden="true">{index + 1}</span>{line + "\n"}</span>) : t("np.empty-file")}</pre>}
      <div className="git-np-foot">
        <p className="git-np-where"><Icon name="Folder" small/>{destination
          ? <span title={destination}>{t("ct.will-create")} <span className="g-mono">{homeRelative(destination)}</span>{t("np.where-tail")}</span>
          : <span className="g-warn">{t("ct.bad-name")}</span>}</p>
        {error && <div className="g-banner bad git-np-note" role="alert">{error}</div>}
        <div className="git-np-submit"><span className="g-muted">{t("np.again")}</span>
          <button type="submit" form="git-np-form" className="g-btn pri" disabled={pending || !built.ok || !destination || !authorReady || !ownerReady}
            title={!authorReady ? t("np.author-needed") : undefined}>{pending ? t("ct.working") : t("np.check")}</button></div>
      </div>
    </section>
    {preview && <ConfirmDialog title={t("np.create", {name: String(values.name)})} lines={preview.lines} onClose={() => setPreview(null)}
      onConfirm={async () => {
        // The preview is spent once Confirm runs: whatever happens, the dialog closes and the form says why.
        try { onCreated(await api.createScaffold(preview.id)); }
        catch (cause) { setError(message(cause)); }
      }}>
      <details><summary>{t("np.files-n", {n: preview.files.length})}</summary>
        <ul className="git-ci-lines">{preview.files.map(item => <li key={item.path} className="g-mono">{item.path} · {item.bytes} B</li>)}</ul></details>
    </ConfirmDialog>}
  </div>;
}

/** New project: a scaffold, made into a folder of the projects folder with git init and a first commit, after a preview. */
export function NewProject({api, hostId, root, categories, onClose, onCreated}: {api: CatalogApi; hostId: string; root: string;
  categories: string[]; onClose(): void; onCreated(made: Created): void}) {
  const t = useT();
  const [view, setView] = useState<ScaffoldsView | null>(null);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => {
    let live = true;
    api.scaffolds(hostId).then(result => { if (live) { setView(result); setKey(result.offered[0]?.key ?? ""); } }, failure => { if (live) setError(message(failure)); });
    return () => { live = false; };
  }, [api, hostId]);
  const entry = view?.offered.find(item => item.key === key);
  const picker = view && <Field label={t("np.scaffold")}><span className="git-np-pick">
    <select className="g-inp" value={key} onChange={event => setKey(event.target.value)}>
      {view.offered.map(item => <option key={item.key} value={item.key}>{item.scaffold.title}</option>)}</select>
    {entry && <span className="g-chip line">{t(sourceKey[entry.source])}</span>}</span></Field>;
  return <div className="g-page git-new-project" role="region" aria-label={t("np.title")}>
    <nav className="git-ci-path git-np-crumbs" aria-label={t("np.path")}>
      <button type="button" className="g-btn ghost sm" onClick={onClose}>{t("section.catalog")}</button>
      <Icon name="ChevronRight" small/><span className="g-muted">{t("np.title")}</span>
    </nav>
    <PageHead title={t("np.title")} sub={t("np.sub")} actions={<button type="button" className="g-btn" onClick={onClose}><Icon name="ArrowLeft" small/>{t("np.back")}</button>}/>
    {!view && !error && <p className="g-state-page" role="status">{t("np.loading")}</p>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {view && view.rejected.length > 0 && <details className="g-banner warn git-np-rejected"><summary>{t("np.rejected", {n: view.rejected.length})}</summary>
      <ul>{view.rejected.map(item => <li key={item.source + item.name}><strong>{item.name}</strong> ({t(sourceKey[item.source])}): {item.issues.join(" ")}</li>)}</ul></details>}
    {view && !view.offered.length && <p className="g-state-page">{t("np.none")}</p>}
    {view && entry && <ScaffoldForm key={entry.key} api={api} hostId={hostId} root={root} categories={categories} entry={entry} suggested={view.suggested}
      accounts={view.accounts} onCreated={onCreated} picker={picker}/>}
  </div>;
}
