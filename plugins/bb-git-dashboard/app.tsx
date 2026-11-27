import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_useAppPanel, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { rpc } from "./src/adapters/bb/rpc.ts";
import type { GitAction } from "./src/core/git.ts";
import type { Copy, Failure } from "./src/core/workspace.ts";
import { projectTree, repositoryKey, nestedFolders, type FolderNode, type Source, type Project } from "./src/core/project-workspace.ts";
import { ProjectWorkspace } from "./src/ui/project-workspace.tsx";
import type { ConnectionApi } from "./src/ui/connection-wizard.tsx";
import type { RepositoryApi } from "./src/ui/repository-panel.tsx";
import { Worktree } from "./src/ui/worktree.tsx";
import { Remotes, type RemoteApi } from "./src/ui/remotes.tsx";
import { InboxPage, InboxToasts } from "./src/ui/pulls/inbox-page.tsx";
import type { AlertSummary, InboxApi, InboxItem } from "./src/ui/pulls/inbox-api.ts";
import { PrPage } from "./src/ui/review/pr-page.tsx";
import { IssuePage } from "./src/ui/review/issue-page.tsx";
import { parseRef, refPath, type ReviewApi } from "./src/ui/review/review-api.ts";
import "./src/ui/git.css";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
type Host = {id: string; name: string};
const signal = "git-workspace-changed";
const inboxSignal = "inbox-alerts";
const tab = {id:"git-pinned", availability:"action"} as const;
const pullTab = {id:"git-pinned-pr",availability:"action",context:{kind:"nav-panel",panelId:"git"}} as const;
function failed(result: Failure): never { throw new Error(result.code + " · " + result.next); }

function useCatalog() {
  const client = useRpc<typeof rpc>();
  const [hiddenRepositories,setHiddenRepositories] = useState<string[]>([]);
  const [copies, setCopies] = useState<Copy[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [projects,setProjects] = useState<Project[]>([]);
  const [locations,setLocations] = useState<{projectId:string;hostId:string;path:string;name:string|null}[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const next = await client.call("catalog");
      setHiddenRepositories(next.hiddenRepositories);
      setCopies(next.copies);
      setHosts(next.hosts);
      setProjects(next.projects);
      setLocations(next.locations);
      setError("");
    } catch { setError("Cannot load repository catalog."); }
    finally { setLoaded(true); }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  useRealtime(signal, reload);
  const hidden = new Set(projects.filter(project => project.hidden).map(project => project.id));
  const projectCopies = useMemo(() => copies.filter(copy => !projects.some(p => p.hidden && p.id === copy.projectId)),[copies,projects]);
  const visibleCopies = useMemo(() => projectCopies.filter(copy => !hiddenRepositories.includes(JSON.stringify([copy.projectId ?? "",repositoryKey(copy)]))),[projectCopies,hiddenRepositories]);
  return {client, copies:visibleCopies,projectCopies,hiddenRepositories, hosts,
    projects:projects.filter(project => !project.hidden), hiddenProjects:projects.filter(project => project.hidden),
    locations:locations.filter(location => !hidden.has(location.projectId)), loaded, error, reload};
}

function BoundWorktree({copy, client, host, attach, pin}: {
  copy: Copy; client: Client; host?: string; attach?(path: string): Promise<void>; pin?(): void;
}) {
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  useRealtime(signal, changed);
  const run = useCallback(async (action: GitAction) => {
    const result = await client.call("git", {copyId:copy.id, action});
    if (!result.ok) return failed(result);
    return result.value;
  }, [client, copy.id]);
  const operations = useCallback(() => client.call("operations", {copyId:copy.id}), [client, copy.id]);
  return <Worktree copy={copy} host={host ?? copy.hostId} run={run} refresh={revision} loadOperations={operations} attach={attach} pin={pin}/>;
}

function ProjectsSidebar({subPath}: {subPath:string}) {
  const {client,projects,projectCopies:copies,hiddenRepositories,hosts,hiddenProjects,reload,error,loaded} = useCatalog();
  const navigate = useBbNavigate();
  const groups = useMemo(() => projectTree(projects,copies), [projects,copies]);
  const [query,setQuery] = useState("");
  const folders = useMemo(() => nestedFolders(groups,query), [groups,query]);
  const [closed,setClosed] = useState<Set<string>>(new Set());
  const open = (path:string) => navigate.toPluginPanel("git", {subPath:path});
  const [manage,setManage] = useState<string|null>(null);
  const [confirm,setConfirm] = useState<{source:Source;mode:"unlink"|"trash"}|null>(null);
  const [typed,setTyped] = useState("");
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  async function act(run:()=>Promise<void>) {
    setBusy(true);
    setNotice("");
    try { await run(); await reload(); }
    catch (err) { setNotice(err instanceof Error ? err.message : "Операция не выполнена"); }
    finally { setBusy(false); }
  }
  async function visibility(project:Project,hidden:boolean) {
    const result = await client.call("projectVisibility",{projectId:project.id,hidden});
    if (!result.ok) throw new Error(result.next);
    if (hidden && (subPath === "project/"+encodeURIComponent(project.id) ||
      copies.some(copy => copy.projectId === project.id && copy.id === subPath.split("/")[0]))) open("");
    setManage(null);
  }
  function folderView(folder:FolderNode) {
    const expanded = Boolean(query.trim()) || !closed.has(folder.key);
    const heading = <><span aria-hidden="true">{expanded ? "▾" : "▸"}</span><strong>{folder.label}</strong><small>{folder.count}</small></>;
    return <section key={folder.key}>
      {query.trim() ? <div className="git-folder">{heading}</div> :
        <button className="git-folder" aria-expanded={expanded} onClick={() => setClosed(previous => {
          const next = new Set(previous);
          if (next.has(folder.key)) next.delete(folder.key);
          else next.add(folder.key);
          return next;
        })}>{heading}</button>}
      {expanded && <div className="git-folder-children">{folder.rows.map(group => {
        const path = "project/" + encodeURIComponent(group.id);
        const current = subPath === path || group.repositories.some(repo => repo.copies.some(copy => copy.id === subPath.split("/")[0]));
        return <div key={path}><div className="git-sidebar-row">
          <button className="git-project-link" title={group.name} aria-current={current} onClick={() => open(path)}>{group.name}</button>
          {<button disabled={busy} aria-label={"Источники и действия · "+group.name} aria-expanded={manage === group.id}
            onClick={() => {setManage(manage === group.id ? null : group.id);setConfirm(null);setNotice("");}}>⋯</button>}
        </div>
        {manage === group.id && <div className="git-source-actions">
          {group.repositories.length > 0 && <strong>Репозитории</strong>}
          {group.repositories.map(repo => {
            const hidden = hiddenRepositories.includes(JSON.stringify([group.id,repo.key]));
            return <button key={repo.key} disabled={busy} onClick={() => void act(async () => {
              const result = await client.call("repositoryVisibility",{projectId:group.id,copyId:repo.copies[0].id,hidden:!hidden});
              if (!result.ok) throw new Error(result.next);
              if (!hidden && repo.copies.some(c => c.id === subPath.split("/")[0])) open("project/"+encodeURIComponent(group.id));
            })}>{hidden ? "Вернуть" : "Убрать из каталога"} · {repo.name}</button>;
          })}
          <strong>Источники</strong>
          {!group.sources?.length && <small>Источников нет</small>}
          {group.sources?.map(source => <div key={source.id} className="git-source-item">
            <small>{hosts.find(host => host.id === source.hostId)?.name ?? source.hostId}{source.isDefault && " · Основной"}</small>
            <code>{source.path}</code>
            {confirm?.source.id === source.id ? <>
              <strong>{confirm.mode === "trash" ? "Переместить папку со всем содержимым в Корзину на этом хосте?" : "Отвязать этот источник от проекта BB? Файлы сохранятся."}</strong>
              {confirm.mode === "trash" && <input aria-label="Введите полный путь" placeholder="Введите полный путь" value={typed} onChange={e => setTyped(e.target.value)}/>}
              <button disabled={busy || (confirm.mode === "trash" && typed !== source.path)} onClick={() => void act(async () => {
                const result = await client.call("removeSource",{projectId:group.id,sourceId:source.id,path:source.path,hostId:source.hostId,mode:confirm.mode});
                if (!result.ok) throw new Error(result.next);
                setNotice(confirm.mode === "trash" ? "Папка перемещена в Корзину. Источник можно отвязать." : "Источник отвязан.");
                setConfirm(null);
              })}>Подтвердить</button>
              <button disabled={busy} onClick={() => setConfirm(null)}>Отмена</button>
            </> : <>
              <button disabled={busy} onClick={() => setConfirm({source,mode:"unlink"})}>Отвязать источник от BB</button>
              <button disabled={busy} onClick={() => {setTyped("");setConfirm({source,mode:"trash"});}}>Переместить папку в Корзину…</button>
            </>}
          </div>)}
          {group.id && <button disabled={busy} onClick={() => void act(() => visibility(group,true))}>Убрать проект из Git Workspace</button>}
        </div>}</div>;
      })}{folder.children.map(folderView)}</div>}
    </section>;
  }
  return <nav className="git-ws git-sidebar" aria-label="Проекты Git">
    <input type="search" aria-label="Найти проект" placeholder="Проект, папка или источник…" value={query}
      onChange={event => setQuery(event.target.value)}/>
    <button aria-current={subPath === ""} onClick={() => open("")}>Все проекты</button>
    {notice && <p role="status">{notice}</p>}
    <div className="git-sidebar-list" role="region" aria-label="Список проектов" tabIndex={0}>
      {error && <p role="alert">{error}</p>}
      {!loaded && <p role="status">Загрузка…</p>}
      {loaded && !error && !folders.length && <p role="status">Проекты не найдены</p>}
      {folders.map(folderView)}
      {hiddenProjects.length > 0 && <details><summary>Скрытые проекты ({hiddenProjects.length})</summary>
        {hiddenProjects.map(p => <button key={p.id} disabled={busy} onClick={() => void act(() => visibility(p,false))}>Вернуть · {p.name}</button>)}</details>}
    </div>
  </nav>;
}

/** The value of an `ok` answer without its envelope; a failure throws its code. */
function okValue<T extends {ok: boolean}>(result: T): Omit<Extract<T, {ok: true}>, "ok"> {
  if (!result.ok) failed(result as unknown as Failure);
  const {ok: _ok, ...value} = result as Extract<T, {ok: true}>;
  return value;
}

function Dashboard({subPath}: {subPath: string}) {
  const {client, copies, hosts, projects, locations, loaded, error} = useCatalog();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const api = useMemo<RemoteApi & RepositoryApi & ConnectionApi & {trees(id:string):Promise<import("./src/core/git.ts").GitResult>}>(() => ({
    checkConnection: async input => {
      const result = await client.call("checkConnection",input);
      if (!result.ok) throw new Error(result.code);
      return result.value;
    },
    saveConnection: async input => {
      const result = await client.call("saveConnection",input);
      if (!result.ok) throw new Error(result.code);
      return result.value;
    },
    accounts: async () => {const result=await client.call("accounts");return result.ok ? result.items : failed(result);},
    repositories: async (accountId,page,refresh) => {const result=await client.call("repositories",{accountId,page,refresh});return result.ok ? result.value : failed(result);},
    pulls: async (repo,page) => {const result=await client.call("pulls",{accountId:repo.accountId,repoId:repo.id,page});return result.ok ? result : failed(result);},
    pull: async (repo,number) => {const result=await client.call("pull",{accountId:repo.accountId,repoId:repo.id,number});return result.ok ? result.value : failed(result);},
    trees: async copyId => {
      const result = await client.call("git",{copyId,action:{kind:"worktrees"}});
      return result.ok ? result.value : failed(result);
    },
    status: async copyId => {const result=await client.call("git",{copyId,action:{kind:"status"}});return result.ok ? result.value : failed(result);},
    compare: async (copyId,base,head) => {const result=await client.call("git",{copyId,action:{kind:"compare",base,head}});return result.ok ? result.value : failed(result);},
    prepare: async (repo,action) => {const result=await client.call("prepare",{accountId:repo.accountId,repoId:repo.id,action});return result.ok ? result.value : failed(result);},
    publish: async previewId => {const result=await client.call("publish",{previewId});return result.ok ? result.value : failed(result);},
    activity: () => client.call("remoteActivity"),
    link: async copyId => {
      const result = await client.call("repositoryLink",{copyId});
      return result.ok ? result.target : failed(result);
    },
    ci: {
      runs: async (copyId,filter,page) => okValue(await client.call("ciRuns",{copyId,filter,page})),
      run: async (copyId,runId) => okValue(await client.call("ciRun",{copyId,runId})),
      log: async (copyId,runId,jobId) => okValue(await client.call("ciLog",{copyId,runId,jobId})),
      workflows: async copyId => okValue(await client.call("ciWorkflows",{copyId})),
      form: async (copyId,workflowId,ref) => okValue(await client.call("ciForm",{copyId,workflowId,ref})),
      prepare: async (copyId,action) => okValue(await client.call("ciPrepare",{copyId,action})),
      confirm: async previewId => { okValue(await client.call("ciConfirm",{previewId})); },
      threads: async copyId => okValue(await client.call("ciThreads",{copyId})),
      ask: async (copyId,runId,jobId) => okValue(await client.call("ciAsk",{copyId,runId,jobId})),
      send: async (copyId,runId,jobId,threadIds) => okValue(await client.call("ciSend",{copyId,runId,jobId,threadIds})),
      subscribe: async (copyId,threadIds) => okValue(await client.call("ciSubscribe",{copyId,threadIds})),
      openThread: threadId => navigate.toThread(threadId),
    },
    history: {
      page: async (copyId,offset) => okValue(await client.call("historyPage",{copyId,offset})).value,
      revision: async copyId => okValue(await client.call("historyRevision",{copyId})).revision,
      commit: async (copyId,hash) => okValue(await client.call("historyCommit",{copyId,hash})).value,
      patch: async (copyId,hash,path) => okValue(await client.call("historyPatch",{copyId,hash,path})).text,
    },
    forgeStatus: async (copyId,recheck) => {
      const result = await client.call("forgeStatus",{copyId,recheck});
      return result.ok ? result.value : failed(result);
    },
    forgeConnect: async (copyId,accountId) => {
      const result = await client.call("forgeConnect",{copyId,accountId});
      if (!result.ok) failed(result);
    },
    setLink: async (copyId,target) => {
      const result = await client.call("linkRepository",{copyId,target});
      if (!result.ok) failed(result);
    },
    features: async (copyId,section) => {
      const result = await client.call("repositoryFeatures",{copyId,section});
      return result.ok ? result : failed(result);
    },
  }), [client]);
  const inbox = useMemo<InboxApi>(() => ({
    list: async tab => okValue(await client.call("inboxList",{tab})),
    alerts: async () => okValue(await client.call("inboxAlerts",{})),
    seen: async () => okValue(await client.call("inboxSeen",{})),
  }), [client]);
  const review = useMemo<ReviewApi>(() => ({
    detail: async ref => okValue(await client.call("prDetail",ref)),
    files: async ref => okValue(await client.call("prFiles",ref)).files,
    prepare: async (ref,action,shown) => okValue(await client.call("prPrepare",{...ref,action,shown})),
    confirm: async previewId => okValue(await client.call("prConfirm",{previewId})),
    ask: async (ref,subject) => okValue(await client.call("prAsk",{...ref,subject})),
    openThread: threadId => navigate.toThread(threadId),
    issue: async ref => okValue(await client.call("issueDetail",ref)).issue,
    issuePrepare: async (accountId,repo,action) => okValue(await client.call("issuePrepare",{accountId,repo,action})),
    issueConfirm: async previewId => okValue(await client.call("issueConfirm",{previewId})),
  }), [client,navigate]);
  const [order,setOrder] = useState<InboxItem[]>([]);
  const [alerts,setAlerts] = useState<AlertSummary|null>(null);
  const readAlerts = useCallback(() => { inbox.alerts().then(setAlerts,() => {}); }, [inbox]);
  useEffect(readAlerts, [readAlerts]);
  useRealtime(inboxSignal, readAlerts);
  const badge = alerts?.badge && alerts.unseen > 0 ? alerts.unseen : null;
  const open = (path:string) => navigate.toPluginPanel("git",path ? {subPath:path} : undefined);
  return <div className="git-ws-frame"><div className="git-ws">
    <InboxToasts alerts={alerts}/>
    {parseRef(subPath) ? (() => {
      const ref = parseRef(subPath)!;
      const step = (by: -1 | 1) => {
        const index = order.findIndex(item => item.accountId === ref.accountId && item.repo === ref.repo && item.number === ref.number);
        const next = index < 0 ? undefined : order[index + by];
        if (next) open(refPath("pr",{accountId:next.accountId,repo:next.repo,number:next.number}));
      };
      return <>
        <nav aria-label="Git workspace" className="git-row git-section-tabs">
          <button type="button" onClick={() => open("")}>Projects</button>
          <button type="button" onClick={() => open("inbox")}>My PRs</button>
          <span>{ref.repo} {ref.kind === "pr" ? "#" + ref.number : ref.number === "new" ? "· new issue" : "issue #" + ref.number}</span>
        </nav>
        {ref.kind === "pr" && typeof ref.number === "number"
          ? <PrPage key={subPath} api={review} accountId={ref.accountId} repo={ref.repo} number={ref.number} onStep={order.length ? step : undefined}/>
          : <IssuePage key={subPath} api={review} accountId={ref.accountId} repo={ref.repo} number={ref.number}
            onCreated={number => open(refPath("issue",{accountId:ref.accountId,repo:ref.repo,number}))}/>}
      </>;
    })() : subPath === "inbox" ? <>
      <nav aria-label="Git workspace" className="git-row git-section-tabs">
        <button type="button" onClick={() => open("")}>Projects</button>
        <span>My PRs</span>
      </nav>
      <InboxPage api={inbox} alerts={alerts} onSeen={() => { inbox.seen().then(setAlerts,() => {}); }}
        onOpen={(item,list) => { setOrder(list); open(refPath("pr",{accountId:item.accountId,repo:item.repo,number:item.number})); }}/>
    </> : subPath === "remotes" ? <>
      <nav aria-label="Git workspace" className="git-row git-section-tabs">
        <button type="button" onClick={() => open("")}>Projects</button>
        <span>Provider repositories</span>
      </nav>
      <Remotes api={api} hosts={hosts} copies={copies} onOpen={open} onPin={(repo,number) => {
        if (!panel.openTab({tab:pullTab,params:{accountId:repo.accountId,repoId:repo.id,number},title:repo.name+" #"+number})) {
          throw new Error("The panel did not accept this pull request.");
        }
      }}/>
    </> : <ProjectWorkspace copies={copies} hosts={hosts} projects={projects} locations={locations} subPath={subPath}
      loaded={loaded} error={error} api={api} onOpen={open} inboxBadge={badge}
      onOpenIssue={(accountId,repo,number) => open(refPath("issue",{accountId,repo,number}))}
      onAttach={async (hostId,root,projectId) => {
        const result = await client.call("attach",{hostId,root,projectId});
        return result.ok ? result.value : failed(result);
      }}
      onClone={async (hostId,source,destination,projectId) => {
        const result = await client.call("cloneLocal",{hostId,source,destination,projectId});
        return result.ok ? result.value : failed(result);
      }}
      renderWorktree={(copy,host,attach) => <BoundWorktree key={copy.id} copy={copy} client={client} host={host} attach={attach}
        pin={() => panel.openTab({tab:{...tab,context:{kind:"nav-panel",panelId:"git"}},params:{copyId:copy.id},title:copy.repositoryName})}/> }/>}
  </div></div>;
}

function ThreadGit({threadId}: {threadId: string}) {
  const client = useRpc<typeof rpc>();
  const panel = experimental_useAppPanel();
  const [context, setContext] = useState<Awaited<ReturnType<typeof loadContext>>>();
  const [error, setError] = useState("");
  function loadContext() { return client.call("context", {threadId}); }
  const refresh = useCallback(() => {
    client.call("context", {threadId}).then(setContext, () => setError("Cannot read thread environment."));
  }, [client, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime(signal, refresh);
  async function authorize(permission: "none" | "read" | "write") {
    if (!context?.ok) return;
    try {
      const result = await client.call("permission", {threadId, copyId:context.copy.id, permission});
      if (!result.ok) return failed(result);
      refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Cannot change permission."); }
  }
  return <div className="git-ws">
    {error && <p role="alert" className="git-section git-error">{error}</p>}
    {!context ? <p className="git-section" role="status">Reading thread environment…</p> : !context.ok
      ? <p className="git-section">{context.code} · Attach this thread’s working copy from Git.</p>
      : <>
        <div className="git-section">
          <label>Agent access{" "}
            <select value={context.permission} onChange={event => void authorize(event.target.value as "none" | "read" | "write")}>
              <option value="none">Revoked</option><option value="read">Read</option><option value="write">Stage and commit</option>
            </select>
          </label>
        </div>
        <BoundWorktree key={context.copy.id} copy={context.copy} client={client}
          pin={() => { if (!panel.openTab({tab:{...tab,context:{kind:"thread"}}, params:{copyId:context.copy.id}})) setError("The panel did not accept this tab."); }}/>
      </>}
  </div>;
}

function PinnedGit({params}: {params: JsonValue | null}) {
  const {client, copies, hosts, loaded} = useCatalog();
  const copyId = params && typeof params === "object" && !Array.isArray(params) ? params.copyId : undefined;
  const copy = copies.find(copy => copy.id === copyId);
  return <div className="git-ws">{copy ? <BoundWorktree key={copy.id} copy={copy} client={client} host={hosts.find(host => host.id === copy.hostId)?.name}/>
    : <p className="git-section">{loaded ? "Pinned worktree is unavailable." : "Reading pinned worktree…"}</p>}</div>;
}

function PinnedPull({params}:{params:JsonValue|null}) {
  const client = useRpc<typeof rpc>();
  const [detail,setDetail] = useState<import("./src/core/providers.ts").PullDetails>();
  const [error,setError] = useState("");
  const [revision,setRevision] = useState(0);
  const target = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const {accountId,repoId,number} = target;
  useEffect(() => {
    let active = true;
    if (typeof accountId !== "string" || typeof repoId !== "string" || typeof number !== "number") return;
    client.call("pull",{accountId,repoId,number}).then(result => {
      if (!active) return;
      if (result.ok) {setDetail(result.value);setError("");}
      else setError(result.code + " · " + result.next);
    }, () => {if(active) setError("Cannot read this pull request.");});
    return () => {active=false;};
  },[accountId,client,number,repoId,revision]);
  return <div className="git-ws"><div className="git-section">
    <button onClick={() => setRevision(value => value+1)}>Refresh PR</button>
    {error && <p className="git-error" role="alert">{error}</p>}
    {detail && <><h2>#{detail.pull.number} {detail.pull.title}</h2>
      <p className="git-path">{String(accountId)} · {detail.pull.state} · {detail.pull.head.repo}:{detail.pull.head.branch} → {detail.pull.base.repo}:{detail.pull.base.branch}</p>
      <p className="git-muted git-path">{detail.pull.head.sha ?? "Head revision unavailable"}</p>
      {detail.issues.map(issue => <p key={issue} className="git-muted">{issue}</p>)}
      {detail.checks.map((check,index) => <p key={index}>{check.name} · {check.state}</p>)}
      {detail.diff !== null && <pre className="git-code">{detail.diff}</pre>}
    </>}
  </div></div>;
}

function Approval({interaction,submit,cancel}:PluginPendingInteractionProps) {
  const [pending,setPending] = useState(false);
  const [error,setError] = useState("");
  const payload = interaction.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const {operationId,lines} = payload;
  if (typeof operationId !== "string" || !Array.isArray(lines)) return null;
  async function respond(approved:boolean) {
    if (typeof operationId !== "string") return;
    setPending(true);
    try { if (approved) await submit(operationId); else await cancel(); }
    catch {setError("Could not submit this decision.");setPending(false);}
  }
  return <div className="git-ws git-section">
    <strong>{interaction.title}</strong>
    {lines.filter(line => typeof line === "string").map((line,index) => <p className="git-path" key={index}>{line}</p>)}
    {error && <span role="alert">{error}</span>}
    <div className="git-row">
      <button className="git-primary" disabled={pending} onClick={() => void respond(true)}>Approve operation</button>
      <button disabled={pending} onClick={() => void respond(false)}>Cancel</button>
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.experimental_tab({...pullTab,title:"Pinned pull request",icon:"GitPullRequest",layout:"flush",component:PinnedPull});
  app.slots.pendingInteraction({id:"git-confirm",component:Approval});
  app.slots.navPanel({id:"git", title:"Git", icon:"GitBranch", path:"git", component:Dashboard, experimental_sidebar:ProjectsSidebar});
  app.slots.experimental_tab({id:"git-thread", title:"Git", icon:"GitBranch", context:{kind:"thread"}, availability:"fixed", layout:"flush", component:ThreadGit});
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"GitBranch", context:{kind:"thread"}, availability:"action", layout:"flush", component:PinnedGit});
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"GitBranch", context:{kind:"nav-panel", panelId:"git"}, availability:"action", layout:"flush", component:PinnedGit});
});
