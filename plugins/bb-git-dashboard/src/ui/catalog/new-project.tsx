import { useEffect, useMemo, useState, type FormEvent } from "react";
import { clonePath } from "../../core/catalog/catalog.ts";
import type { CiForge } from "../../core/ci-templates/render.ts";
import { scaffoldCi } from "../../core/scaffolds/ci.ts";
import type { ScaffoldsView } from "../../core/scaffolds/contract.ts";
import { buildScaffold } from "../../core/scaffolds/model.ts";
import { commonParams } from "../../core/scaffolds/overlay.ts";
import { validOwner } from "../../core/scaffolds/repository.ts";
import type { TemplateValues } from "../../core/templating/engine.ts";
import { CodedError } from "../../core/workspace.ts";
import { message } from "../ci/ci-api.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { ParamField } from "../templating/param-field.tsx";
import type { CatalogApi } from "./catalog-api.ts";

type Offered = ScaffoldsView["offered"][number];
const forges: [CiForge | "", string][] = [["", "No CI file"], ["github", "GitHub Actions"], ["gitea", "Gitea Actions"], ["gitlab", "GitLab CI"], ["azure", "Azure Pipelines"]];
const sources = {builtin: "Built-in", settings: "Settings", folder: "Folder"} as const;

/** The form of one scaffold: where the project goes, its values, CI, author, and the files as they will be written. */
type Created = Awaited<ReturnType<CatalogApi["createScaffold"]>>;
function ScaffoldForm({api, hostId, root, categories, entry, suggested, accounts, onCreated}: {api: CatalogApi; hostId: string; root: string;
  categories: string[]; entry: Offered; suggested: TemplateValues; accounts: ScaffoldsView["accounts"]; onCreated(made: Created): void}) {
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
    } catch (cause) { return {ok: false as const, problem: cause instanceof CodedError ? "Check the values: " + cause.detail + "." : message(cause)}; }
  }, [entry, values, suggested, forge]);
  const destination = clonePath(root, category, String(values.name));
  const authorReady = author.name.trim() !== "" && /^[^\s@<>]+@[^\s@<>]+$/.test(author.email.trim());
  const file = built.ok ? built.files.find(item => item.path === shown) ?? built.files.find(item => item.path === "README.md") ?? built.files[0] : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true); setError("");
    api.prepareScaffold({hostId, key: entry.key, values, category, ciForge: forge || null, author: {name: author.name.trim(), email: author.email.trim()},
      repository: remote.on && account ? {accountId: account.id, owner: remote.owner.trim() || null, visibility: remote.visibility} : null})
      .then(setPreview, failure => setError(message(failure))).finally(() => setPending(false));
  };
  return <form className="git-stack git-ci-dispatch" aria-label={"New " + entry.scaffold.title} onSubmit={submit}>
    <div className="git-row git-ci-run-title"><h3>{entry.scaffold.title}</h3><span className="git-muted">{sources[entry.source]}</span></div>
    <p className="git-muted">{entry.scaffold.description}</p>
    <label>Category<select value={category} onChange={event => setCategory(event.target.value)}>
      {categories.map(value => <option key={value} value={value}>{value || "(the projects folder itself)"}</option>)}</select></label>
    {params.map(param => <ParamField key={param.name} param={param} value={values[param.name] ?? param.default}
      onChange={value => setValues(previous => ({...previous, [param.name]: value}))}/>)}
    <label>CI<select value={forge} onChange={event => setForge(event.target.value as CiForge | "")}>
      {forges.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="git-row">
      <label>Commit author<input value={author.name} maxLength={200} placeholder="Name" onChange={event => setAuthor(previous => ({...previous, name: event.target.value}))}/></label>
      <label>Email<input value={author.email} maxLength={200} type="email" placeholder="name@example.org" onChange={event => setAuthor(previous => ({...previous, email: event.target.value}))}/></label>
    </div>
    {accounts.length > 0 && <label className="git-ci-check"><input type="checkbox" checked={remote.on} onChange={event => {
      setRemote(previous => ({...previous, on: event.target.checked}));
      // The CI follows the repository's forge.
      if (event.target.checked && account) setForge(account.kind);
    }}/>
      <span>Create a repository on a forge and push main</span></label>}
    {remote.on && <div className="git-row">
      <label>Account<select value={remote.accountId} onChange={event => {
        const next = accounts.find(item => item.id === event.target.value);
        setRemote(previous => ({...previous, accountId: event.target.value}));
        if (next) setForge(next.kind);
      }}>{accounts.map(item => <option key={item.id} value={item.id}>{item.label} ({item.kind})</option>)}</select></label>
      <label>{account?.kind === "azure" ? "Azure project" : "Owner (empty: " + (account?.username ?? "you") + ")"}
        <input value={remote.owner} maxLength={255} placeholder={account?.kind === "gitlab" ? "group/subgroup" : account?.kind === "azure" ? "Project" : "organization"}
          onChange={event => setRemote(previous => ({...previous, owner: event.target.value}))}/></label>
      {<label>{account?.kind === "azure" ? "Visibility (the project's)" : "Visibility"}<select value={remote.visibility} onChange={event => setRemote(previous => ({...previous, visibility: event.target.value as "private" | "public"}))}>
        <option value="private">Private</option><option value="public">Public</option></select></label>}
    </div>}
    {remote.on && remote.visibility === "public" && <p className="git-error" role="alert">Public: anyone can read the repository and its history.</p>}
    {remote.on && !ownerReady && <p className="git-muted">{account?.kind === "azure" ? "Name the Azure project the repository goes into." : "The owner is an organization or a group path."}</p>}
    <p className="git-muted git-path">{destination ?? "The name must be a folder name: letters, digits and . _ -"}</p>
    {!built.ok ? <p className="git-error" role="alert">{built.problem}</p> : <div className="git-new-project-files">
      <ul aria-label="Files">{built.files.map(item => <li key={item.path}>
        <button type="button" className="git-link git-path" aria-pressed={file?.path === item.path} onClick={() => setShown(item.path)}>{item.path}</button></li>)}</ul>
      {file && <pre className="git-code" aria-label={"Content of " + file.path}>{file.text || "(empty)"}</pre>}
    </div>}
    {error && <p className="git-error" role="alert">{error}</p>}
    <div className="git-row"><button type="submit" className="git-primary" disabled={pending || !built.ok || !destination || !authorReady || !ownerReady}>
      {pending ? "Working…" : "Review project…"}</button></div>
    {preview && <ConfirmDialog title={"Create " + String(values.name)} lines={preview.lines} onClose={() => setPreview(null)}
      onConfirm={async () => {
        // The preview is spent once Confirm runs: whatever happens, the dialog closes and the form says why.
        try { onCreated(await api.createScaffold(preview.id)); }
        catch (cause) { setError(message(cause)); }
      }}>
      <details><summary>{preview.files.length} files</summary>
        <ul className="git-ci-lines">{preview.files.map(item => <li key={item.path} className="git-path">{item.path} · {item.bytes} B</li>)}</ul></details>
    </ConfirmDialog>}
  </form>;
}

/** New project: a scaffold, made into a folder of the projects folder with git init and a first commit, after a preview. */
export function NewProject({api, hostId, root, categories, onClose, onCreated}: {api: CatalogApi; hostId: string; root: string;
  categories: string[]; onClose(): void; onCreated(made: Created): void}) {
  const [view, setView] = useState<ScaffoldsView | null>(null);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => {
    let live = true;
    api.scaffolds(hostId).then(result => { if (live) { setView(result); setKey(result.offered[0]?.key ?? ""); } }, failure => { if (live) setError(message(failure)); });
    return () => { live = false; };
  }, [api, hostId]);
  const entry = view?.offered.find(item => item.key === key);
  return <section className="git-stack git-ci" aria-label="New project">
    <div className="git-row git-ci-toolbar"><h2>New project</h2><span className="git-ci-spacer"/><button type="button" onClick={onClose}>Back to the catalog</button></div>
    {!view && !error && <p className="git-muted" role="status">Reading the scaffolds…</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {view && <>
      {view.rejected.length > 0 && <details><summary>{view.rejected.length} own scaffold(s) not offered</summary>
        <ul>{view.rejected.map(item => <li key={item.source + item.name}><strong>{item.name}</strong> ({sources[item.source]}): {item.issues.join(" ")}</li>)}</ul></details>}
      <label className="git-ci-template-pick">Scaffold<select value={key} onChange={event => setKey(event.target.value)}>
        {view.offered.map(item => <option key={item.key} value={item.key}>{item.scaffold.title}</option>)}</select></label>
      {entry && <ScaffoldForm key={entry.key} api={api} hostId={hostId} root={root} categories={categories} entry={entry} suggested={view.suggested} accounts={view.accounts} onCreated={onCreated}/>}
    </>}
  </section>;
}
