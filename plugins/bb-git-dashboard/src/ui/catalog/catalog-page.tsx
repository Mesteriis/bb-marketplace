import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { categoryOf, localState } from "../../core/catalog/rows.ts";
import { homeRelative } from "../../core/short-path.ts";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import { useT } from "../i18n/use-t.tsx";
import { NewProject } from "./new-project.tsx";
import { CloneDialog, type Host } from "./clone-dialog.tsx";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import type { BulkResult, CatalogApi, CatalogView, LocalRow, PullsResult, RemoteRow } from "./catalog-api.ts";
import "./catalog.css";

type Tab = "local" | "remote";
type Bulk = "status" | "fetch" | "pull";
type T = ReturnType<typeof useT>;
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
export const forgeName = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;
export const relative = (root: string, path: string) => path.startsWith(root.replace(/\/+$/, "") + "/") ? path.slice(root.replace(/\/+$/, "").length + 1) : path;
/** The status of the first projects is read on its own when the catalog opens; the rest on Status. */
const autoStatus = 50;
const bulkLimit = 50;
const pullsLimit = 20;

/** A local project's state: changed files and ahead, behind, clean, or the failure's code. */
function State({result, t}: {result: BulkResult | undefined; t: T}) {
  const state = localState(result);
  if (state.kind === "unknown") return <span className="g-muted">—</span>;
  if (state.kind === "failed") return <span className="g-chip bad" title={state.code}><Icon name="CircleX" small/>{state.code}</span>;
  const parts = [];
  if (state.files) parts.push(<span key="f">{t("ct.files", {n: state.files})}</span>);
  if (state.ahead) parts.push(<strong key="a" className="g-num">↑{state.ahead}</strong>);
  if (state.behind) parts.push(<span key="b" className="g-warn"><strong className="g-num">↓{state.behind}</strong> {t("ct.behind")}</span>);
  if (!parts.length) return <span className="g-muted">{state.upstream ? t("ct.clean") : t("ct.clean-no-upstream")}</span>;
  return <span className="git-catalog-state">{parts.flatMap((part, index) => index ? [<span key={"s" + index} className="g-muted"> · </span>, part] : [part])}</span>;
}

/**
 * The catalog: the projects of a machine's projects folder and every connected account's repositories, as two tables.
 * Local projects get status (read on its own for the first ones), fetch and pull together; a remote repository shows
 * where it is cloned or is cloned on click into a category of the projects folder; the open pull requests of chosen
 * repositories are listed under the table.
 */
export function CatalogPage({api, hosts, initialTab = "local"}: {api: CatalogApi; hosts: Host[];
  /** The tab it opens on: Remote for the address of the former Remote repositories screen. */
  initialTab?: Tab}) {
  const t = useT();
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [view, setView] = useState<CatalogView | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, BulkResult>>(new Map());
  const [asked, setAsked] = useState<Bulk | null>(null);
  const [pulls, setPulls] = useState<PullsResult[] | null>(null);
  const [cloning, setCloning] = useState<RemoteRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{root: string; repository: {path: string; pushed: boolean} | null; notes: string[]} | null>(null);
  // One bulk action at a time: two fetches of the same project would meet on its index lock.
  const [busy, setBusy] = useState(false);
  // Answers belong to the machine they were asked of: a switch of machine makes every answer still on its way stale.
  const machine = useRef({hostId, epoch: 0});
  // Each status, fetch or pull is numbered; a project's row keeps the answer of the latest one asked, so a slow
  // automatic status cannot overwrite what a later pull found.
  const requests = useRef({next: 0, rows: new Map<string, number>()});
  const [viewHost, setViewHost] = useState("");
  const load = useCallback(async (refresh: boolean) => {
    if (!hostId) return;
    const epoch = machine.current.epoch;
    setPending(true); setError("");
    try {
      const value = await api.catalog(hostId, refresh);
      if (machine.current.epoch === epoch) { setView(value); setViewHost(hostId); }
    } catch (failure) { if (machine.current.epoch === epoch) setError(message(failure)); } finally { setPending(false); }
  }, [api, hostId]);
  useEffect(() => {
    machine.current = {hostId, epoch: machine.current.epoch + 1};
    requests.current.rows.clear();
    setPicked(new Set()); setResults(new Map()); setPulls(null); setView(null); setViewHost(""); void load(false);
  }, [load, hostId]);
  useEffect(() => { if (!hostId && hosts[0]) setHostId(hosts[0].id); }, [hosts, hostId]);
  /** Asks a status, fetch or pull of `roots` and keeps each row's answer unless a later request was asked of it. */
  const request = async (roots: string[], action: Bulk) => {
    const epoch = machine.current.epoch;
    const number = ++requests.current.next;
    for (const root of roots) requests.current.rows.set(root, number);
    const answers = await api.bulk(machine.current.hostId, roots, action);
    if (machine.current.epoch !== epoch) return;
    const latest = answers.filter(answer => requests.current.rows.get(answer.root) === number);
    setResults(previous => { const next = new Map(previous); for (const answer of latest) next.set(answer.root, answer); return next; });
  };
  // The first projects' status is read when the catalog shows them, so the table says branch and state without a click.
  // It holds the bulk actions while it runs: two git commands on one project would meet on its index lock.
  useEffect(() => {
    if (!view || viewHost !== hostId) return;
    const roots = view.local.slice(0, autoStatus).map(row => row.path);
    if (!roots.length) return;
    setBusy(true);
    request(roots, "status").catch(() => {}).finally(() => setBusy(false));
  }, [api, hostId, view, viewHost]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every(word => text.toLowerCase().includes(word));
  const byKey = useMemo(() => new Map((view?.remote ?? []).map(row => [row.key, row])), [view]);
  const local = useMemo(() => (view?.local ?? []).filter(row => matches(row.path + " " + (row.key ?? ""))), [view, query]);
  const remote = useMemo(() => (view?.remote ?? []).filter(row => (!account || row.accounts.includes(account)) && matches(row.key + " " + (row.localPath ?? ""))),
    [view, query, account]);
  const toggle = (key: string) => setPicked(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const shown = tab === "local" ? local.map(row => row.path) : remote.map(row => row.key);
  const chosen = shown.filter(key => picked.has(key));
  const all = shown.length > 0 && chosen.length === shown.length;
  const run = async (action: Bulk) => {
    setBusy(true);
    try { await request(chosen, action); } finally { setBusy(false); }
  };
  const tooMany = chosen.length > bulkLimit ? t("ct.bulk-limit") : undefined;
  const failedSources = view?.sources.filter(source => !source.ok) ?? [];
  const open = (path: string) => void api.open(hostId, path).catch(failure => setError(message(failure)));
  const showPulls = () => {
    const repos = remote.filter(row => picked.has(row.key)).map(row => ({accountId: row.repo.accountId, repoId: row.repo.id}));
    api.pulls(repos).then(setPulls, failure => setError(message(failure)));
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Tab = event.key === "Home" ? "local" : event.key === "End" ? "remote" : tab === "local" ? "remote" : "local";
    setTab(next);
    (event.currentTarget.parentElement?.querySelector("[data-tab=\"" + next + "\"]") as HTMLElement | null)?.focus();
  };

  if (creating && view) return <NewProject api={api} hostId={hostId} root={view.root} categories={view.categories} onClose={() => setCreating(false)}
    onCreated={made => { setCreating(false); setCreated(made); void load(false); }}/>;
  return <div className="g-page git-catalog" aria-label={t("section.catalog")} role="region">
    <PageHead title={t("section.catalog")} sub={view ? <><span title={view.root}>{t("ct.root")} <span className="g-mono">{homeRelative(view.root)}</span></span> · {t("ct.accounts", {n: view.sources.length})}</> : undefined}
      actions={<>
        {hosts.length > 1 && <select className="g-inp" aria-label={t("ct.machine")} value={hostId} onChange={event => setHostId(event.target.value)}>
          {hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select>}
        <input type="search" className="g-inp git-catalog-search" aria-label={t("ct.search")} placeholder={t("ct.search")} value={query} onChange={event => setQuery(event.target.value)}/>
        <button type="button" className="g-btn" disabled={!view} onClick={() => { setCreated(null); setCreating(true); }}><Icon name="Plus" small/>{t("ct.new")}</button>
        <button type="button" className="g-btn" disabled={pending} onClick={() => void load(true)}><Icon name="RotateCcw" small/>{t("ov.refresh")}</button>
      </>}/>
    {created && <div className="g-banner" role="status"><span>{t("ct.created", {root: homeRelative(created.root)})}
      {created.repository && <> {t(created.repository.pushed ? "ct.created-pushed" : "ct.created-repo", {path: created.repository.path})}</>}</span>
      <button type="button" className="g-btn sm" onClick={() => open(created.root)}>{t("ct.open")}</button></div>}
    {created?.notes.map(note => <div key={note} className="g-banner warn" role="status">{note}</div>)}
    {view?.truncated && <div className="g-banner warn" role="status">{t("ct.truncated")}</div>}
    {failedSources.map(source => <div key={source.id} className="g-banner bad" role="alert">
      {t("ct.source-failed", {label: source.label, forge: forgeName[source.kind], error: source.error ?? ""})}
      {source.count ? " " + t("ct.source-kept", {n: source.count}) : ""}</div>)}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!view && !error && <p className="g-state-page" role="status">{t("ct.loading")}</p>}
    {view && <>
      <div className="g-views git-catalog-bar">
        <div role="tablist" aria-label={t("ct.tabs")} className="git-catalog-tabs">
          {(["local", "remote"] as const).map(option => <button key={option} id={"git-catalog-" + option} data-tab={option} type="button" role="tab"
            aria-selected={tab === option} aria-controls="git-catalog-panel" tabIndex={tab === option ? 0 : -1} onClick={() => setTab(option)} onKeyDown={tabKeys}>
            {t(option === "local" ? "ct.local" : "ct.remote")} <span className="g-num git-catalog-count">{option === "local" ? view.local.length : view.remote.length}</span>
          </button>)}
        </div>
        <div className="git-catalog-bulk" role="group" aria-label={t("pj.selected", {n: chosen.length})}>
          {chosen.length > 0 && <span>{t("pj.selected", {n: chosen.length})}</span>}
          {tab === "local" ? <>
            <button type="button" className="g-btn sm" disabled={!chosen.length || !!tooMany || busy} title={tooMany}
              onClick={() => void run("status").catch(failure => setError(message(failure)))}><Icon name="RotateCcw" small/>{t("ct.status")}</button>
            <button type="button" className="g-btn sm" disabled={!chosen.length || !!tooMany || busy} title={tooMany} onClick={() => setAsked("fetch")}>
              <Icon name="RotateCcw" small/>{t("pj.fetch")}</button>
            <button type="button" className="g-btn sm" disabled={!chosen.length || !!tooMany || busy} title={tooMany} onClick={() => setAsked("pull")}>
              <Icon name="ArrowDown" small/>{t("pj.pull")}</button>
            {busy && <span className="g-muted" role="status">{t("ct.working")}</span>}
          </> : <>
            <button type="button" className="g-btn sm" disabled={!chosen.length || chosen.length > pullsLimit}
              title={chosen.length > pullsLimit ? t("ct.pulls-limit") : undefined} onClick={showPulls}><Icon name="GitPullRequest" small/>{t("ct.pulls")}</button>
            {view.sources.length > 1 && <select className="g-inp git-catalog-account" aria-label={t("ct.account")} value={account} onChange={event => setAccount(event.target.value)}>
              <option value="">{t("ct.account-all")}</option>
              {view.sources.map(source => <option key={source.id} value={source.id}>{t("ct.account-one", {label: source.label})}</option>)}</select>}
          </>}
        </div>
      </div>
      <div className="g-scroll git-catalog-scroll" role="tabpanel" id="git-catalog-panel" aria-labelledby={"git-catalog-" + tab}>
        {tab === "local"
          ? <LocalTable rows={local} view={view} byKey={byKey} results={results} picked={picked} all={all} t={t} query={query}
            onAll={() => setPicked(previous => { const next = new Set(previous); for (const key of shown) if (all) next.delete(key); else next.add(key); return next; })}
            onPick={toggle} onOpen={open}/>
          : <RemoteTable rows={remote} view={view} picked={picked} all={all} t={t} query={query}
            onAll={() => setPicked(previous => { const next = new Set(previous); for (const key of shown) if (all) next.delete(key); else next.add(key); return next; })}
            onPick={toggle} onOpen={open} onClone={setCloning}/>}
      </div>
      {tab === "local" && local.length > 0 && <p className="git-catalog-foot g-muted">{t("ct.foot")}</p>}
      {pulls && tab === "remote" && <section className="git-catalog-pulls" aria-labelledby="git-catalog-pulls-title">
        <div className="git-catalog-pulls-head"><h2 id="git-catalog-pulls-title">{t("ct.pulls-title")} <span className="g-num g-muted">{pulls.reduce((sum, result) => sum + result.pulls.length, 0)}</span></h2>
          <button type="button" className="g-btn ghost sm" onClick={() => setPulls(null)}>{t("ct.hide")}</button></div>
        <ul className="git-catalog-pull-list">{pulls.flatMap(result => {
          const row = view.remote.find(entry => entry.repo.id === result.repoId && entry.repo.accountId === result.accountId);
          const path = row?.repo.path ?? result.repoId;
          if (!result.ok) return [<li key={result.accountId + result.repoId} className="git-catalog-pull-note"><span className="g-mono">{path}</span> <span className="g-chip bad">{result.code}</span></li>];
          if (!result.pulls.length) return [<li key={result.accountId + result.repoId} className="git-catalog-pull-note g-muted"><span className="g-mono">{path}</span> · {t("ct.no-pulls")}</li>];
          return result.pulls.map(pull => <li key={result.accountId + result.repoId + pull.number}>
            <button type="button" className="git-catalog-pull" onClick={() => api.openPull(result.accountId, path, pull.number)}>
              <span className="git-catalog-pull-text"><strong>{pull.title}</strong>
                <span className="g-muted">{path} #{pull.number} · {pull.head.branch} → {pull.base.branch}</span></span>
              <Icon name="ChevronRight" small/></button></li>);
        })}</ul>
      </section>}
    </>}
    {asked && view && <ConfirmDialog title={t(asked === "fetch" ? "ct.fetch-title" : "ct.pull-title", {n: chosen.length})}
      lines={[t(asked === "fetch" ? "ct.fetch-what" : "ct.pull-what"), t("ct.keys"), ...chosen.slice(0, 15).map(path => relative(view.root, path)),
        ...(chosen.length > 15 ? [t("ct.and-more", {n: chosen.length - 15})] : [])]}
      onConfirm={() => run(asked)} onClose={() => setAsked(null)}/>}
    {cloning && view && <CloneDialog row={cloning} view={view} hosts={hosts} hostId={hostId} api={api}
      onClose={() => setCloning(null)} onDone={() => { setCloning(null); void load(false); }}/>}
  </div>;
}

function Pick({label, checked, onChange}: {label: string; checked: boolean; onChange(): void}) {
  return <td className="git-catalog-pick"><input type="checkbox" aria-label={label} checked={checked} onChange={onChange}/></td>;
}

function LocalTable({rows, view, byKey, results, picked, all, t, query, onAll, onPick, onOpen}: {rows: LocalRow[]; view: CatalogView; byKey: Map<string, RemoteRow>;
  results: Map<string, BulkResult>; picked: Set<string>; all: boolean; t: T; query: string; onAll(): void; onPick(key: string): void; onOpen(path: string): void}) {
  if (!rows.length) return <p className="g-state-page" role="status">{query ? t("ct.none") : t("ct.no-local")}</p>;
  return <table className="g-table two git-catalog-table" aria-label={t("ct.local")}>
    <thead><tr>
      <th className="git-catalog-pick"><input type="checkbox" aria-label={t("pj.select-all")} checked={all} onChange={onAll}/></th>
      <th>{t("ct.col.project")}</th><th>{t("ct.col.category")}</th><th>{t("ct.col.branch")}</th><th>{t("ct.col.state")}</th><th>{t("ct.col.remote")}</th><th><span className="g-sr">{t("ct.col.actions")}</span></th>
    </tr></thead>
    <tbody>{rows.map(row => {
      const path = relative(view.root, row.path);
      const category = categoryOf(view.root, row.path, view.categories);
      const result = results.get(row.path);
      const state = localState(result);
      const forge = row.key ? byKey.get(row.key) : undefined;
      return <tr key={row.path} data-picked={picked.has(row.path) || undefined}>
        <Pick label={t("ct.choose", {name: path})} checked={picked.has(row.path)} onChange={() => onPick(row.path)}/>
        <td><div className="git-catalog-two"><strong>{row.name}</strong><span className="g-mono g-muted">{path}</span></div></td>
        <td>{category ? <span className="g-chip line">{category}</span> : <span className="g-muted">—</span>}</td>
        <td>{state.kind === "ok" ? <code className="git-catalog-branch" title={state.branch ?? undefined}>{state.branch ?? t("ct.detached")}</code> : <span className="g-muted">—</span>}</td>
        <td><State result={result} t={t}/></td>
        <td className="git-catalog-remote">{forge ? <>{forgeName[forge.kind]} · {forge.repo.path}</> : row.key ? <span className="g-mono">{row.key}</span> : <span className="g-muted">{t("ct.no-remote")}</span>}</td>
        <td className="git-catalog-act"><button type="button" className="g-btn sm" onClick={() => onOpen(row.path)}>{t("ct.open")}</button></td>
      </tr>;
    })}</tbody>
  </table>;
}

function RemoteTable({rows, view, picked, all, t, query, onAll, onPick, onOpen, onClone}: {rows: RemoteRow[]; view: CatalogView; picked: Set<string>; all: boolean;
  t: T; query: string; onAll(): void; onPick(key: string): void; onOpen(path: string): void; onClone(row: RemoteRow): void}) {
  if (!rows.length) return <p className="g-state-page" role="status">{query ? t("ct.none") : view.sources.length ? t("ct.no-remote-repos") : t("ct.no-accounts")}</p>;
  const label = (id: string) => view.sources.find(source => source.id === id)?.label ?? id;
  return <table className="g-table two git-catalog-table" aria-label={t("ct.remote")}>
    <thead><tr>
      <th className="git-catalog-pick"><input type="checkbox" aria-label={t("pj.select-all")} checked={all} onChange={onAll}/></th>
      <th>{t("ct.col.repository")}</th><th>{t("ct.col.here")}</th><th><span className="g-sr">{t("ct.col.actions")}</span></th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.key} data-picked={picked.has(row.key) || undefined}>
      <Pick label={t("ct.choose", {name: row.repo.path})} checked={picked.has(row.key)} onChange={() => onPick(row.key)}/>
      <td><div className="git-catalog-two"><strong>{row.repo.path}</strong><span className="g-muted">{forgeName[row.kind]} · {row.accounts.map(label).join(", ")}</span></div></td>
      <td>{row.localPath ? <span className="git-catalog-here"><span className="g-chip good">{t("ct.cloned")}</span><span className="g-mono">{relative(view.root, row.localPath)}</span></span>
        : <span className="g-muted">—</span>}</td>
      <td className="git-catalog-act">{row.localPath ? <button type="button" className="g-btn sm" onClick={() => onOpen(row.localPath!)}>{t("ct.open")}</button>
        : <button type="button" className="g-btn sm" onClick={() => onClone(row)}><Icon name="Download" small/>{t("ct.clone")}</button>}</td>
    </tr>)}</tbody>
  </table>;
}
