import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clonePath } from "../../core/catalog/catalog.ts";
import { NewProject } from "./new-project.tsx";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import type { BulkResult, CatalogApi, CatalogView, PullsResult, RemoteRow } from "./catalog-api.ts";
import "./catalog.css";

type Host = {id: string; name: string};
type Tab = "local" | "remote";
type Bulk = "status" | "fetch" | "pull";
const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
const forgeName = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;
const relative = (root: string, path: string) => path.startsWith(root + "/") ? path.slice(root.length + 1) : path;

/** One project's last status, fetch or pull, in a few words. */
function bulkText(result: BulkResult | undefined): string {
  if (!result) return "";
  if (!result.ok) return result.code ?? "Failed";
  const value = result.value!;
  const sync = value.upstream ? (value.ahead || value.behind ? "↑" + (value.ahead ?? 0) + " ↓" + (value.behind ?? 0) : "in sync") : "no upstream";
  return [value.branch ?? "detached", sync, value.files?.length ? value.files.length + " changed" : "clean"].join(" · ");
}

/**
 * The catalog: the projects of a machine's projects folder and every connected account's repositories. Local
 * projects get status, fetch and pull together; a remote repository shows where it is cloned or is cloned on click
 * into a category of the projects folder; the open pull requests of chosen repositories are listed together.
 */
export function CatalogPage({api, hosts}: {api: CatalogApi; hosts: Host[]}) {
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [view, setView] = useState<CatalogView | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<Tab>("local");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, BulkResult>>(new Map());
  const [asked, setAsked] = useState<Bulk | null>(null);
  const [pulls, setPulls] = useState<PullsResult[] | null>(null);
  const [cloning, setCloning] = useState<RemoteRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{root: string; repository: {path: string; pushed: boolean} | null; notes: string[]} | null>(null);
  // One bulk action at a time: two fetches of the same project would meet on its index lock.
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    if (!hostId) return;
    setPending(true); setError("");
    try { setView(await api.catalog(hostId, refresh)); } catch (failure) { setError(message(failure)); } finally { setPending(false); }
  }, [api, hostId]);
  useEffect(() => { setPicked(new Set()); setResults(new Map()); setPulls(null); void load(false); }, [load]);
  useEffect(() => { if (!hostId && hosts[0]) setHostId(hosts[0].id); }, [hosts, hostId]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every(word => text.toLowerCase().includes(word));
  const local = useMemo(() => (view?.local ?? []).filter(row => matches(row.path + " " + (row.key ?? ""))), [view, query]);
  const remote = useMemo(() => (view?.remote ?? []).filter(row => matches(row.key + " " + (row.localPath ?? ""))), [view, query]);
  const toggle = (key: string) => setPicked(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const shown = tab === "local" ? local.map(row => row.path) : remote.map(row => row.key);
  const chosen = shown.filter(key => picked.has(key));
  const run = async (action: Bulk) => {
    setBusy(true);
    try {
      const answers = await api.bulk(hostId, chosen, action);
      setResults(previous => { const next = new Map(previous); for (const answer of answers) next.set(answer.root, answer); return next; });
    } finally { setBusy(false); }
  };
  const tooMany = chosen.length > 50 ? "At most 50 projects at a time" : undefined;
  const failedSources = view?.sources.filter(source => !source.ok) ?? [];

  if (creating && view) return <NewProject api={api} hostId={hostId} root={view.root} categories={view.categories} onClose={() => setCreating(false)}
    onCreated={made => { setCreating(false); setCreated(made); void load(false); }}/>;
  return <section className="git-catalog" aria-label="Catalog">
    <div className="git-row git-catalog-toolbar">
      <h2>Catalog</h2>
      {hosts.length > 1 && <select aria-label="Machine" value={hostId} onChange={event => setHostId(event.target.value)}>
        {hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select>}
      <input type="search" aria-label="Search the catalog" placeholder="Name, path or remote" value={query} onChange={event => setQuery(event.target.value)}/>
      <button type="button" disabled={pending} onClick={() => void load(true)}>Refresh</button>
      <button type="button" disabled={!view} onClick={() => { setCreated(null); setCreating(true); }}>New project…</button>
    </div>
    {created && <div role="status">
      <p>Created <span className="git-path">{created.root}</span> with its first commit; it is attached in Git.
        {created.repository && <> Repository <span className="git-path">{created.repository.path}</span>{created.repository.pushed ? " has main." : " was created."}</>}
        <button type="button" className="git-link" onClick={() => void api.open(hostId, created.root).catch(failure => setError(message(failure)))}>Open</button></p>
      {created.notes.map(note => <p key={note} className="git-error">{note}</p>)}
    </div>}
    {view && <p className="git-muted">Projects folder: <span className="git-path">{view.root}</span>{view.truncated ? " · the walk stopped early: some projects are missing" : ""}</p>}
    {failedSources.map(source => <p key={source.id} className="git-error" role="alert">{source.label} ({forgeName[source.kind]}) did not answer: {source.error}
      {source.count ? " · showing the " + source.count + " repositories it listed before" : ""}</p>)}
    {error && <p className="git-error" role="alert">{error}</p>}
    {!view && !error && <p className="git-muted" role="status">Reading the projects folder and the accounts…</p>}
    {view && <>
      <nav className="git-inbox-tabs" aria-label="Catalog tabs">
        <button type="button" aria-current={tab === "local" ? "page" : undefined} onClick={() => setTab("local")}>Local <span className="git-inbox-count">{view.local.length}</span></button>
        <button type="button" aria-current={tab === "remote" ? "page" : undefined} onClick={() => setTab("remote")}>Remote <span className="git-inbox-count">{view.remote.length}</span></button>
      </nav>
      <div className="git-row git-catalog-bulk">
        <label className="git-review-check"><input type="checkbox" checked={shown.length > 0 && chosen.length === shown.length}
          onChange={event => setPicked(previous => { const next = new Set(previous); for (const key of shown) if (event.target.checked) next.add(key); else next.delete(key); return next; })}/> All shown</label>
        <span className="git-muted">{chosen.length} chosen</span>
        {tab === "local" ? <>
          <button type="button" disabled={!chosen.length || !!tooMany || busy} title={tooMany} onClick={() => void run("status").catch(failure => setError(message(failure)))}>Status</button>
          <button type="button" disabled={!chosen.length || !!tooMany || busy} title={tooMany} onClick={() => setAsked("fetch")}>Fetch</button>
          <button type="button" disabled={!chosen.length || !!tooMany || busy} title={tooMany} onClick={() => setAsked("pull")}>Pull</button>
          {busy && <span className="git-muted" role="status">Working…</span>}
        </> : <button type="button" disabled={!chosen.length || chosen.length > 20} title={chosen.length > 20 ? "At most 20 repositories at a time" : undefined}
          onClick={() => {
            const repos = remote.filter(row => picked.has(row.key)).map(row => ({accountId: row.repo.accountId, repoId: row.repo.id}));
            api.pulls(repos).then(setPulls, failure => setError(message(failure)));
          }}>Open pull requests</button>}
      </div>
      {tab === "local" ? <ul className="git-catalog-list" aria-label="Local projects">
        {local.map(row => <li key={row.path} className="git-row">
          <input type="checkbox" aria-label={"Choose " + relative(view.root, row.path)} checked={picked.has(row.path)} onChange={() => toggle(row.path)}/>
          <span className="git-catalog-name"><strong>{row.name}</strong> <span className="git-muted git-path">{relative(view.root, row.path)}</span></span>
          <span className="git-muted git-path">{row.key ?? "no forge remote"}</span>
          {results.get(row.path) && <span className="git-catalog-result" data-ok={results.get(row.path)!.ok || undefined}>{bulkText(results.get(row.path))}</span>}
          <span className="git-ci-spacer"/>
          <button type="button" onClick={() => void api.open(hostId, row.path).catch(failure => setError(message(failure)))}>Open</button>
        </li>)}
        {!local.length && <li className="git-muted">{query ? "Nothing matches the search." : "No projects in the projects folder."}</li>}
      </ul> : <ul className="git-catalog-list" aria-label="Remote repositories">
        {remote.map(row => <li key={row.key} className="git-row">
          <input type="checkbox" aria-label={"Choose " + row.repo.path} checked={picked.has(row.key)} onChange={() => toggle(row.key)}/>
          <span className="git-catalog-name"><strong>{row.repo.path}</strong> <span className="git-muted">{forgeName[row.kind]} · {row.accounts.map(id => view.sources.find(source => source.id === id)?.label ?? id).join(", ")}</span></span>
          <span className="git-ci-spacer"/>
          {row.localPath ? <><span className="git-review-tag">cloned</span><span className="git-muted git-path">{relative(view.root, row.localPath)}</span>
            <button type="button" onClick={() => void api.open(hostId, row.localPath!).catch(failure => setError(message(failure)))}>Open</button></>
            : <button type="button" onClick={() => setCloning(row)}>Clone…</button>}
        </li>)}
        {!remote.length && <li className="git-muted">{query ? "Nothing matches the search." : view.sources.length ? "No repositories on the connected accounts." : "No accounts connected."}</li>}
      </ul>}
      {pulls && tab === "remote" && <section className="git-catalog-pulls" aria-label="Open pull requests of the chosen repositories">
        <div className="git-row"><h3>Open pull requests</h3><button type="button" className="git-link" onClick={() => setPulls(null)}>Close</button></div>
        {pulls.map(result => {
          const row = view.remote.find(entry => entry.repo.id === result.repoId && entry.repo.accountId === result.accountId);
          return <div key={result.accountId + result.repoId} className="git-stack">
            <strong className="git-path">{row?.repo.path ?? result.repoId}</strong>
            {!result.ok ? <p className="git-error">{result.code}</p> : !result.pulls.length ? <p className="git-muted">No open pull requests.</p>
              : <ul>{result.pulls.map(pull => <li key={pull.number}><button type="button" className="git-link"
                onClick={() => api.openPull(result.accountId, row?.repo.path ?? "", pull.number)}>#{pull.number} {pull.title}</button>
                <span className="git-muted"> · {pull.head.branch} → {pull.base.branch}</span></li>)}</ul>}
          </div>;
        })}
      </section>}
    </>}
    {asked && view && <ConfirmDialog title={(asked === "fetch" ? "Fetch " : "Pull ") + chosen.length + (chosen.length === 1 ? " project" : " projects")}
      lines={[asked === "fetch" ? "Fetch each project's origin: its branches, no tags; branches deleted there leave their origin/… copies." :
        "Fetch each project's origin (branches deleted there leave their origin/… copies), then fast-forward the branch where it follows origin, is clean and is behind.",
        "SSH remotes use your SSH keys; HTTPS remotes the connected account of their server.", ...chosen.slice(0, 15).map(path => relative(view.root, path)),
        ...(chosen.length > 15 ? ["and " + (chosen.length - 15) + " more"] : [])]}
      onConfirm={() => run(asked)} onClose={() => setAsked(null)}/>}
    {cloning && view && <CloneDialog row={cloning} root={view.root} categories={view.categories} hostId={hostId} api={api}
      onClose={() => setCloning(null)} onDone={() => { setCloning(null); void load(false); }}/>}
  </section>;
}

/** Where to clone: a category of the projects folder and a name, asked every time; then the clone's preview to confirm. */
function CloneDialog({row, root, categories, hostId, api, onClose, onDone}: {row: RemoteRow; root: string; categories: string[]; hostId: string;
  api: CatalogApi; onClose(): void; onDone(): void}) {
  const [category, setCategory] = useState(categories.includes("") ? "" : categories[0] ?? "");
  const [name, setName] = useState(row.repo.name);
  const [preview, setPreview] = useState<{id: string; lines: string[]} | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!preview) element?.showModal();
    return () => element?.close();
  }, [preview]);
  const destination = clonePath(root, category, name.trim());
  if (preview) return <ConfirmDialog key="clone" title={"Clone " + row.repo.path} lines={preview.lines} onConfirm={async () => { await api.clone(preview.id); }}
    onClose={done => done ? onDone() : onClose()}/>;
  return <dialog ref={dialog} className="git-ci-dialog" aria-labelledby="git-clone-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <form className="git-stack" onSubmit={event => {
      event.preventDefault();
      if (!destination) return;
      setPending(true); setError("");
      api.prepareClone(row.repo, hostId, destination).then(setPreview, failure => setError(message(failure))).finally(() => setPending(false));
    }}>
      <h2 id="git-clone-title">Clone {row.repo.path}</h2>
      <label className="git-stack">Category
        <select aria-label="Category" value={category} onChange={event => setCategory(event.target.value)}>
          {categories.map(value => <option key={value} value={value}>{value || "(the projects folder itself)"}</option>)}</select></label>
      <label className="git-stack">Folder name
        <input aria-label="Folder name" value={name} onChange={event => setName(event.target.value)}/></label>
      <p className="git-muted git-path">{destination ?? "Use letters, digits and . _ - for the name."}</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="git-row git-ci-dialog-actions">
        <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" className="git-primary" disabled={pending || !destination}>{pending ? "Working…" : "Review clone"}</button>
      </div>
    </form>
  </dialog>;
}
