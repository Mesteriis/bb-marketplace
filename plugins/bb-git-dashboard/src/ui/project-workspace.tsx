import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { projectTree, type WorkspaceRepository } from "../core/project-workspace.ts";
import type { GitResult } from "../core/git.ts";
import type { Account } from "../core/providers.ts";
import type { RepositorySection } from "../core/repository-features.ts";
import type { Copy } from "../core/workspace.ts";
import { ConnectionWizard, type ConnectionApi } from "./connection-wizard.tsx";
import { RepositoryPanel, type RepositoryApi } from "./repository-panel.tsx";
import "./project-workspace.css";
import { HistoryPanel } from "./history/history-panel.tsx";

type Host = {id:string;name:string};
type Project = {id:string;name:string};
type Location = {hostId:string;projectId:string;path:string;name:string|null};
const sections = ["Code","History","Actions","Issues","Variables"] as const;
type Section = typeof sections[number];

export function ProjectWorkspace({copies,hosts,projects,locations,subPath,loaded,error,api,onOpen,onAttach,onClone,renderWorktree,inboxBadge = null}: {
  copies:Copy[]; hosts:Host[]; projects:Project[]; locations:Location[]; subPath:string;
  loaded:boolean; error:string; api:RepositoryApi & ConnectionApi & {trees(id:string):Promise<GitResult>};
  onOpen(path:string):void; onAttach(hostId:string,root:string,projectId?:string):Promise<Copy>;
  onClone(hostId:string,source:string,destination:string,projectId?:string):Promise<Copy>;
  renderWorktree(copy:Copy,host:string,attach:(root:string)=>Promise<void>):ReactNode;
  /** Unseen My PRs alerts, or null when there are none or the badge is off. */
  inboxBadge?:number|null;
}) {
  const groups = useMemo(() => projectTree(projects,copies), [copies,projects]);
  const [first, second] = subPath.split("/");
  const selected = groups.flatMap(group => group.repositories.map(repo => ({group,repo})))
    .find(({repo}) => repo.copies.some(copy => copy.id === first));
  const group = first === "project" ? groups.find(group => group.id === decodeURIComponentSafe(second)) :
    selected?.group;
  const repo = selected?.repo;
  const copy = repo?.copies.find(copy => copy.id === first);
  const section = sections.find(section => section.toLowerCase() === second) ?? "Code";
  const [query,setQuery] = useState("");
  const [connections,setConnections] = useState(false);
  const [adding,setAdding] = useState(false);
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [accountError,setAccountError] = useState("");
  const [connecting,setConnecting] = useState(false);

  useEffect(() => {
    let active = true;
    api.accounts().then(value => {if(active) setAccounts(value);}, message => {if(active) setAccountError(errorMessage(message));});
    return () => { active = false; };
  }, [api]);

  const openCopy = (copy:Copy,next:Section = section) => onOpen(copy.id + (next === "Code" ? "" : "/" + next.toLowerCase()));
  const hostName = (id:string) => hosts.find(host => host.id === id)?.name ?? id;
  const availableLocations = locations.filter(location => (!group || location.projectId === group.id) &&
    !copies.some(copy => copy.hostId === location.hostId && copy.root === location.path));

  return <div className="git-project-layout git-catalog-layout">
    <header className="git-project-bar">
      <strong className="git-project-brand"><span aria-hidden="true">⑂</span> Makosh Git</strong>
      {copy && <button onClick={() => onOpen("")}>Все проекты</button>}
      {!copy && <input aria-label="Поиск по каталогу" placeholder="Репозиторий, ветка или путь…" type="search"
        value={query} onChange={event => setQuery(event.target.value)}/>}
      <button onClick={() => onOpen("inbox")}>Мои PR{inboxBadge !== null &&
        <span className="git-inbox-badge" aria-label={inboxBadge + " new"}>{inboxBadge}</span>}</button>
      <button aria-expanded={connections} onClick={() => setConnections(!connections)}>Подключения</button>
    </header>
    {connections &&       <section className="git-project-connections">
        <h2>Connections</h2>
        <button type="button" onClick={() => setConnecting(true)}>+ Add connection</button>
        {accounts.map(account => <div className="git-connection" key={account.id}>
          <span aria-hidden="true">⛓</span> <span>{account.label}</span>
          <span className="git-muted">{{azure: "Azure Repos", gitea: "Gitea", gitlab: "GitLab", github: "GitHub"}[account.kind]}</span>
        </div>)}
        {accountError && <p role="alert" className="git-error">{accountError}</p>}
        <button type="button" onClick={() => onOpen("remotes")}>Browse provider repositories</button>
      </section>}
    <main className="git-project-main">
      {copy && <nav className="git-repository-tabs" aria-label="Repository sections">
        {sections.map(item => <button key={item} type="button" aria-current={item === section ? "page" : undefined}
          disabled={!copy && item !== "Code"} onClick={() => {if(copy) openCopy(copy,item);}}>{item}</button>)}
        <span className="git-repository-context" title={repo?.name}>{repo?.name ?? "Choose a repository"}</span>
      </nav>}
      {error && <p className="git-panel-message git-error" role="alert">{error}</p>}
      {!loaded && <p role="status" className="git-panel-message">Loading projects and repositories…</p>}
      {loaded && section === "Code" && <>
        <section className="git-project-code">
          <div className="git-project-title"><h2>{copy ? "Рабочие копии" : group?.name ?? "Репозитории"}</h2>
            <button type="button" className="git-primary" aria-expanded={adding}
              onClick={() => setAdding(value => !value)}>{adding ? "Закрыть" : "+ Подключить копию"}</button>
          </div>
          {adding && <AddCopy key={group?.id ?? ""} hosts={hosts} locations={availableLocations} projects={projects}
            onSubmit={async (hostId,root,source,sourceProject) => {
              const registered = source ? await onClone(hostId,source,root,group?.id || undefined) :
                await onAttach(hostId,root,sourceProject || group?.id || undefined);
              setAdding(false);
              onOpen("project/" + encodeURIComponent(registered.projectId ?? sourceProject ?? group?.id ?? ""));
            }}/>}
          {(copy || first === "project" ? groups.filter(item => item === group) : first ? [] : groups.filter(item => item.repositories.length)).map(item =>
            <section className="git-stack" key={item.id}>
              {!group && !query && <h3>{item.name}</h3>}
              {(repo ? [repo] : item.repositories).map(repository =>
                <RepositoryRows key={repository.key} repo={repository} query={copy ? "" : query}
                  api={api} hostName={hostName} onOpen={copy => openCopy(copy,"Code")}
                  attach={async path => {
                    const attached = await onAttach(repository.copies[0].hostId,path,item.id || undefined);
                    openCopy(attached,"Code");
                  }}/>)}
              {!item.repositories.length && !query && <p className="git-muted">Нет подключённых репозиториев</p>}
            </section>)}
          {!first && !copies.length && <p>Добавьте рабочую копию, чтобы увидеть репозиторий и его worktree.</p>}
          {first && !group && <p role="status">Рабочая копия или проект недоступны.</p>}

        </section>
        {copy && renderWorktree(copy,hostName(copy.hostId),async root => {
          const registered = await onAttach(copy.hostId,root,group?.id || undefined);
          openCopy(registered,"Code");
        })}
      </>}
      {loaded && copy && section === "History" && <HistoryPanel key={copy.id} api={api.history} copyId={copy.id}/>}
      {loaded && copy && section !== "Code" && section !== "History" && <RepositoryPanel key={copy.id + section} copyId={copy.id} name={repo!.name}
        accounts={accounts} api={api} onAddConnection={() => setConnecting(true)} section={section.toLowerCase() as RepositorySection}/>}
      {connecting && <ConnectionWizard api={api} onClose={() => setConnecting(false)} onSaved={account => {
        setAccounts(previous => [...previous.filter(item => item.id !== account.id),account]);
        setConnecting(false);
      }}/>}
    </main>
  </div>;
}

function decodeURIComponentSafe(value:string|undefined) {
  try { return value ? decodeURIComponent(value) : ""; }
  catch { return ""; }
}

export function errorMessage(error:unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function AddCopy({hosts,locations,projects,onSubmit}: {
  hosts:Host[]; locations:Location[]; projects:Project[];
  onSubmit(hostId:string,root:string,source:string,projectId?:string):Promise<void>;
}) {
  const [manual,setManual] = useState(false);
  const [key,setKey] = useState("");
  const [host,setHost] = useState(hosts.length === 1 ? hosts[0].id : "");
  const [path,setPath] = useState("");
  const [source,setSource] = useState("");
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");
  const locationKey = (location:Location) => JSON.stringify([location.projectId,location.hostId,location.path]);
  const usePath = manual || !locations.length;
  const location = usePath ? undefined : locations.find(item => locationKey(item) === key) ??
    (locations.length === 1 ? locations[0] : undefined);
  const canSubmit = usePath ? !!host && !!path.trim() : !!location;
  const onAdd = async (event:FormEvent) => {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setError("");
    try {
      if (location) await onSubmit(location.hostId,location.path,"",location.projectId);
      else await onSubmit(host,path.trim(),source.trim());
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  };
  return <form className="git-add-copy git-stack" onSubmit={onAdd}>
    {locations.length > 0 && <label><input type="checkbox" checked={manual} disabled={pending}
      onChange={event => {setManual(event.target.checked); setError("");}}/> Указать путь вручную</label>}
    {!usePath ? <label>Рабочая копия проекта BB
      <select disabled={pending} value={location ? locationKey(location) : ""} onChange={event => {setKey(event.target.value); setError("");}}>
        <option value="">Выберите источник или окружение…</option>
        {locations.map(item => <option key={locationKey(item)} value={locationKey(item)}>
          {projects.find(project => project.id === item.projectId)?.name} · {hosts.find(host => host.id === item.hostId)?.name ?? item.hostId} · {item.path}
        </option>)}
      </select></label> : <div className="git-row">
        <select aria-label="Машина" value={host} onChange={event => setHost(event.target.value)}>
          <option value="">Выберите машину</option>{hosts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input aria-label="Путь рабочей копии" placeholder="Абсолютный путь рабочей копии" value={path} onChange={event => setPath(event.target.value)}/>
        <input aria-label="Локальный bare-репозиторий" placeholder="Путь к bare-репозиторию для клонирования" value={source} onChange={event => setSource(event.target.value)}/>
      </div>}
    <button type="submit" disabled={pending || !canSubmit}>{pending ? "Подключение…" : usePath && source.trim() ? "Клонировать" : "Подключить и показать worktree"}</button>
    {error && <p role="alert" className="git-error">{error}</p>}
  </form>;
}

function RepositoryRows({repo,query,api,hostName,onOpen,attach}: {
  repo:WorkspaceRepository; query:string;
  api:{status(id:string):Promise<GitResult>; trees(id:string):Promise<GitResult>};
  hostName(id:string):string; onOpen(copy:Copy):void; attach(path:string):Promise<void>;
}) {
  type Tree = NonNullable<GitResult["worktrees"]>[number];
  const [attachError,setAttachError] = useState("");
  const [trees,setTrees] = useState<Tree[]>([]);
  const [states,setStates] = useState<Record<string,GitResult|null>>({});
  const [notice,setNotice] = useState("");
  useEffect(() => {
    let active = true;
    async function read() {
      setTrees([]);
      setStates({});
      setNotice("");
      let discovered = false;
      for (const copy of repo.copies) {
        if (!active) return;
        if (!discovered) {
          try {
            const list = await api.trees(copy.id);
            if (!active) return;
            setTrees(list.worktrees ?? []);
            discovered = true;
          } catch { /* A different registered copy can still enumerate this repository. */ }
        }
        const result = await api.status(copy.id).catch(() => null);
        if (active) setStates(previous => ({...previous,[copy.id]:result}));
      }
      if (active && !discovered) setNotice("Не удалось получить полный список рабочих копий.");
    }
    void read();
    return () => {active = false;};
  },[repo,api]);
  const known = new Map(repo.copies.map(copy => [copy.root,copy]));
  const paths = new Map<string,Tree>(repo.copies.map(copy => [copy.root,{path:copy.root}]));
  for (const tree of trees) paths.set(tree.path,tree);
  const term = query.trim().toLowerCase();
  const rows = [...paths.values()].filter(tree => {
    const copy = known.get(tree.path);
    return [repo.name,tree.path,tree.branch,copy && states[copy.id]?.branch,hostName(repo.copies[0].hostId)]
      .some(value => value?.toLowerCase().includes(term));
  });
  if (!rows.length && !notice) return null;
  return <details open className="git-catalog-repo">
    <summary>{repo.name}</summary>
    {attachError && <p role="alert">{attachError}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="git-workspace-table"><table><thead><tr>
      <th>Рабочая копия</th><th>Ветка</th><th>Состояние</th><th>Машина и путь</th>
    </tr></thead><tbody>{rows.map(tree => {
      const copy = known.get(tree.path);
      const state = copy && states[copy.id];
      const count = state?.files?.length;
      const name = tree.path.split(/[\\/]/).pop() || tree.path;
      return <tr key={tree.path}>
        <th scope="row">{copy ? <button className="git-table-entry" onClick={() => onOpen(copy)}>{name}</button> :
          <button title="Подключить рабочую копию" onClick={() => {setAttachError(""); void attach(tree.path).catch(error => setAttachError(errorMessage(error)));}}>{name} · Подключить</button>}
          {tree.path === trees[0]?.path && <small>Основная</small>}</th>
        <td>{state?.branch ?? tree.branch ?? (tree.head || state ? "Detached HEAD" : "—")}</td>
        <td>{!copy ? "Не подключена" : state === null ? "Недоступно" : count === undefined ? "Загрузка…" :
          count ? "Изменено файлов: " + count : "Чисто"}</td>
        <td>{hostName(repo.copies[0].hostId)} · {tree.path}</td>
      </tr>;
    })}</tbody></table></div>
  </details>;
}
