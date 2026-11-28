import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_copyToClipboard, experimental_useAppPanel, experimental_usePluginId, Markdown, UrlLink, useBbNavigate, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { rpc } from "./src/adapters/bb/rpc.ts";
import type { GitAction } from "./src/core/git.ts";
import type { Copy, Failure } from "./src/core/workspace.ts";
import { projectTree, repositoryKey, nestedFolders, type FolderNode, type Source, type Project } from "./src/core/project-workspace.ts";
import { ProjectWorkspace } from "./src/ui/project-workspace.tsx";
import { ProjectHead } from "./src/ui/project/project-head.tsx";
import type { ConnectionApi } from "./src/ui/connection-wizard.tsx";
import type { RepositoryApi } from "./src/ui/repository-panel.tsx";
import { Worktree } from "./src/ui/worktree.tsx";
import { Remotes, type RemoteApi } from "./src/ui/remotes.tsx";
import { InboxPage } from "./src/ui/pulls/inbox-page.tsx";
import type { AlertSummary, InboxApi, InboxItem } from "./src/ui/pulls/inbox-api.ts";
import { PrPage } from "./src/ui/review/pr-page.tsx";
import { CiOverview } from "./src/ui/ci/ci-overview.tsx";
import { IssuePage } from "./src/ui/review/issue-page.tsx";
import { parseRef, refPath, type ReviewApi } from "./src/ui/review/review-api.ts";
import { dispatchReviewCommand, REVIEW_COMMANDS, type ReviewCommand } from "./src/ui/code-review/commands.ts";
import { ReviewsPage, type ReviewsApi } from "./src/ui/code-review/reviews-page.tsx";
import { requestOfKey, ReviewOpenOverlay, reviewRoute } from "./src/app/review-open.tsx";
import { useReviewRevisions } from "./src/app/review-signal.ts";
import { ciApi, codeReviewApi, failed, historyApi, okValue } from "./src/app/apis.tsx";
import { ciTab, historyTab, reviewTab, ThreadCi, ThreadHistory, ThreadReview, registerHistoryShortcut, registerReviewSurfaces } from "./src/app/thread-tabs.tsx";
import { Sidebar, type SidebarApi } from "./src/ui/shell/sidebar.tsx";
import { ConnectionsPage, type ConnectionsApi } from "./src/ui/connections-page.tsx";
import { OverviewPage } from "./src/ui/overview/overview-page.tsx";
import { useOverviewApi } from "./src/app/overview-data.tsx";
import { ProjectsRoute, useCopyCategories } from "./src/app/projects-route.tsx";
import { useCopyStates } from "./src/app/copy-states.tsx";
import { useT } from "./src/ui/i18n/use-t.tsx";
import { accountsChanged, onAccountsChanged, withInterface } from "./src/app/interface.tsx";
import "./src/ui/system/tokens.css";
import "./src/ui/system/system.css";
import "./src/ui/git.css";
import { withCodeTheme } from "./src/app/code-theme.tsx";
import { MainSettingsSection } from "./src/app/main-settings.tsx";
import { PrLinkOverlay } from "./src/app/pr-links.tsx";
import { AlertToastsOverlay, useInboxBadge } from "./src/app/alerts.tsx";
import { CatalogPage } from "./src/ui/catalog/catalog-page.tsx";
import type { CatalogApi } from "./src/ui/catalog/catalog-api.ts";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
type Host = {id: string; name: string};
const signal = "git-workspace-changed";
const inboxSignal = "inbox-alerts";
const tab = {id:"git-pinned", availability:"action"} as const;
const pullTab = {id:"git-pinned-pr",availability:"action",context:{kind:"nav-panel",panelId:"git"}} as const;


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

function BoundWorktree({copy, client, host, attach, pin, openReview}: {
  copy: Copy; client: Client; host?: string; attach?(path: string): Promise<void>; pin?(): void; openReview?(path: string): void;
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
  return <Worktree copy={copy} host={host ?? copy.hostId} run={run} refresh={revision} loadOperations={operations} attach={attach} pin={pin} openReview={openReview}/>;
}

function BoundHead({copy, client, onFiles}: {copy: Copy; client: Client; onFiles(count: number): void}) {
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  useRealtime(signal, changed);
  const run = useCallback(async (action: GitAction) => {
    const result = await client.call("git", {copyId:copy.id, action});
    if (!result.ok) return failed(result);
    return result.value;
  }, [client, copy.id]);
  const onState = useCallback((state: import("./src/core/git.ts").GitResult) => onFiles(state.files?.length ?? 0), [onFiles]);
  return <ProjectHead copy={copy} run={run} refresh={revision} onChanged={changed} onState={onState}/>;
}

/** Open comment threads over every line review, for the Reviews count. */
function useOpenReviews(client: Client) {
  const revision = useReviewRevisions().any;
  const [open, setOpen] = useState(0);
  useEffect(() => {
    let active = true;
    client.call("reviewSummaries", {}).then(result => {
      if (active && result.ok) setOpen(result.reviews.filter(row => !row.orphan).reduce((sum, row) => sum + row.open, 0));
    }, () => {});
    return () => { active = false; };
  }, [client, revision]);
  return open;
}

/** Connected accounts, for the Connections count. */
function useAccountCount(client: Client) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const read = () => { client.call("accounts").then(result => { if (active && result.ok) setCount(result.items.length); }, () => {}); };
    read();
    const stop = onAccountsChanged(read);
    return () => { active = false; stop(); };
  }, [client]);
  return count;
}

function ProjectsSidebar({subPath}: {subPath:string}) {
  const {client,projects,projectCopies:copies,hiddenRepositories,hosts,hiddenProjects,reload,error,loaded} = useCatalog();
  const states = useCopyStates(copies, signal);
  const navigate = useBbNavigate();
  const inbox = useInboxBadge();
  const reviews = useOpenReviews(client);
  const accounts = useAccountCount(client);
  const api = useMemo<SidebarApi>(() => ({
    projectVisibility: async (projectId, hidden) => { const result = await client.call("projectVisibility", {projectId, hidden}); if (!result.ok) throw new Error(result.next); },
    repositoryVisibility: async (projectId, copyId, hidden) => { const result = await client.call("repositoryVisibility", {projectId, copyId, hidden}); if (!result.ok) throw new Error(result.next); },
    removeSource: async input => { const result = await client.call("removeSource", input); if (!result.ok) throw new Error(result.next); },
    reload,
  }), [client, reload]);
  return <Sidebar subPath={subPath} open={path => navigate.toPluginPanel("git", path ? {subPath: path} : undefined)} projects={projects} copies={copies}
    hosts={hosts} hiddenRepositories={hiddenRepositories} hiddenProjects={hiddenProjects} loaded={loaded} error={error} api={api}
    counts={{inbox: inbox?.count ?? null, reviews: reviews || null, connections: accounts}} states={states}/>;
}

function Dashboard({subPath}: {subPath: string}) {
  const t = useT();
  const pluginId = experimental_usePluginId();
  const {client, copies, hosts, projects, locations, loaded, error} = useCatalog();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const settingValues = useSettings().values;
  const historyGraph = settingValues?.historyGraph !== false;
  const overview = useOverviewApi(copies);
  const categories = useCopyCategories(projects, copies);
  const groups = useMemo(() => new Map(copies.map(copy => [copy.id, repositoryKey(copy)])), [copies]);
  const reviewRevisions = useReviewRevisions();
  const reviewRevision = reviewRevisions.any;
  const api = useMemo<RemoteApi & RepositoryApi & ConnectionsApi & {trees(id:string):Promise<import("./src/core/git.ts").GitResult>}>(() => ({
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
    accountCheck: async (accountId,refresh) => {const result=await client.call("accountCheck",{accountId,refresh});return result.ok ? result.value : failed(result);},
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
    ci: ciApi(client, navigate),
    history: historyApi(client),
    review: codeReviewApi(client, navigate),
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
  }), [client, navigate]);
  const inbox = useMemo<InboxApi>(() => ({
    list: async tab => okValue(await client.call("inboxList",{tab})),
    history: async tab => okValue(await client.call("inboxHistory",{tab})),
    alerts: async () => okValue(await client.call("inboxAlerts",{})),
    seen: async () => okValue(await client.call("inboxSeen",{})),
    SettingsLink: ({children}) => <UrlLink href={"/settings/plugins/"+encodeURIComponent(pluginId)} className="git-inbox-bell" title="Notification settings">{children}</UrlLink>,
  }), [client, pluginId]);
  const review = useMemo<ReviewApi>(() => ({
    detail: async ref => okValue(await client.call("prDetail",ref)),
    files: async ref => okValue(await client.call("prFiles",ref)).files,
    prepare: async (ref,action,shown) => okValue(await client.call("prPrepare",{...ref,action,shown})),
    confirm: async previewId => okValue(await client.call("prConfirm",{previewId})),
    ask: async (ref,subject) => okValue(await client.call("prAsk",{...ref,subject})),
    drafts: async ref => okValue(await client.call("prDrafts",ref)).drafts,
    linkCandidates: async ref => okValue(await client.call("prLinkCandidates",ref)).threads,
    link: async (ref,threadId) => { okValue(await client.call("prLink",{...ref,threadId})); },
    compose: async (ref,kind) => {
      const {prompt,projectId} = okValue(await client.call("prCompose",{...ref,kind}));
      navigate.toCompose({initialPrompt:prompt,focusPrompt:true,...(projectId ? {projectId} : {})});
    },
    copy: text => { void experimental_copyToClipboard({text}); },
    editDraft: async (commentId,body) => { okValue(await client.call("prDraftEdit",{commentId,body})); },
    dropDraft: async commentId => { okValue(await client.call("prDraftDrop",{commentId})); },
    jira: async () => okValue(await client.call("prJira",{})),
    Markdown: ({content}) => <Markdown content={content}/>,
    Link: ({href,children}) => <UrlLink href={href} className="git-jira-link">{children}</UrlLink>,
    openThread: threadId => navigate.toThread(threadId),
    issue: async ref => okValue(await client.call("issueDetail",ref)).issue,
    issuePrepare: async (accountId,repo,action) => okValue(await client.call("issuePrepare",{accountId,repo,action})),
    issueConfirm: async previewId => okValue(await client.call("issueConfirm",{previewId})),
    issueAsk: async ref => {
      const {prompt,projectId} = okValue(await client.call("issueCompose",ref));
      navigate.toCompose({initialPrompt:prompt,focusPrompt:true,...(projectId ? {projectId} : {})});
    },
  }), [client,navigate]);
  const [order,setOrder] = useState<InboxItem[]>([]);
  const [alerts,setAlerts] = useState<AlertSummary|null>(null);
  const readAlerts = useCallback(() => { inbox.alerts().then(setAlerts,() => {}); }, [inbox]);
  useEffect(readAlerts, [readAlerts]);
  useRealtime(inboxSignal, readAlerts);
  const open = (path:string) => navigate.toPluginPanel("git",path ? {subPath:path} : undefined);
  const catalogApi = useMemo<CatalogApi>(() => ({
    catalog: async (hostId,refresh) => okValue(await client.call("catalogView",{hostId,refresh})),
    bulk: async (hostId,roots,action) => okValue(await client.call("catalogBulk",{hostId,roots,action})).results,
    pulls: async repos => okValue(await client.call("catalogPulls",{repos})).results,
    scaffolds: async hostId => okValue(await client.call("scaffoldsView", {hostId})),
    prepareScaffold: async request => okValue(await client.call("scaffoldPrepare", request)).preview,
    createScaffold: async previewId => okValue(await client.call("scaffoldCreate", {previewId})),
    prepareClone: async (repo,hostId,destination) => {
      const result = await client.call("prepare",{accountId:repo.accountId,repoId:repo.id,action:{kind:"clone",hostId,destination}});
      return result.ok ? result.value : failed(result);
    },
    clone: async previewId => {
      const result = await client.call("publish",{previewId});
      if (!result.ok) return failed(result);
      if (result.value.status !== "completed") throw new Error(result.value.code ?? "OUTCOME_UNKNOWN");
      return {copyId: result.value.copyId ?? null};
    },
    open: async (hostId,path) => {
      const result = await client.call("attach",{hostId,root:path});
      if (!result.ok) failed(result);
      else open(result.value.id);
    },
    openPull: (accountId,repo,number) => open(refPath("pr",{accountId,repo,number})),
  }), [client]);
  const localKeys = useCallback((hostId: string) => catalogApi.catalog(hostId, false).then(view => view.local.map(row => row.key)), [catalogApi]);
  const reviewsApi = useMemo<ReviewsApi>(() => ({
    summaries: async () => okValue(await client.call("reviewSummaries",{})).reviews,
    deleteOrphans: async sessionIds => okValue(await client.call("reviewDeleteOrphans",{sessionIds})),
  }), [client]);
  const openReview = (copyId:string,targetKey:string,file:string|null) => open(reviewRoute(copyId,requestOfKey(targetKey),file));
  return <div className="git-ws-frame"><div className="git-ws">
    {parseRef(subPath) ? (() => {
      const ref = parseRef(subPath)!;
      const index = order.findIndex(item => item.accountId === ref.accountId && item.repo === ref.repo && item.number === ref.number);
      const step = (by: -1 | 1) => {
        const next = index < 0 ? undefined : order[index + by];
        if (next) open(refPath("pr",{accountId:next.accountId,repo:next.repo,number:next.number}));
      };
      return <>
        {ref.kind === "pr" && typeof ref.number === "number"
          ? <PrPage key={subPath} api={review} accountId={ref.accountId} repo={ref.repo} number={ref.number} onStep={order.length ? step : undefined} position={index < 0 ? undefined : {index,total:order.length}} revision={reviewRevisions.byCopy["forge:" + ref.accountId] ?? 0} onList={() => open("inbox")}/>
          : <IssuePage key={subPath} api={review} accountId={ref.accountId} repo={ref.repo} number={ref.number}
            onCreated={number => open(refPath("issue",{accountId:ref.accountId,repo:ref.repo,number}))}/>}
      </>;
    })() : subPath === "reviews" ? <>
      <ReviewsPage api={reviewsApi} revision={reviewRevision} onOpen={(copyId, targetKey) => openReview(copyId, targetKey, null)}/>
    </> : subPath === "ci" ? <>
      <CiOverview api={api.ci} onOpen={(copyId, runId) => open(copyId + "/actions/" + encodeURIComponent(runId))}/>
    </> : subPath === "inbox" ? <>
      <InboxPage api={inbox} alerts={alerts} onSeen={() => { inbox.seen().then(setAlerts,() => {}); }}
        onOpen={(item,list) => { setOrder(list); open(refPath("pr",{accountId:item.accountId,repo:item.repo,number:item.number})); }}/>
    </> : subPath === "catalog" ? <>
      <CatalogPage api={catalogApi} hosts={hosts}/>
    </> : subPath === "" ? <>
      <OverviewPage api={overview} ready={loaded} categories={categories} groups={groups} initialView={settingValues?.overviewView === "board" ? "board" : "list"}/>
    </> : subPath === "connections" ? <>
      <ConnectionsPage api={api} title={t("section.connections")} hosts={hosts} localKeys={localKeys} onBrowse={() => open("remotes")} onChanged={accountsChanged}/>
    </> : subPath === "remotes" ? <>
      <Remotes api={api} hosts={hosts} copies={copies} onOpen={open} onPin={(repo,number) => {
        if (!panel.openTab({tab:pullTab,params:{accountId:repo.accountId,repoId:repo.id,number},title:repo.name+" #"+number})) {
          throw new Error("The panel did not accept this pull request.");
        }
      }}/>
    </> : subPath === "projects" || subPath.startsWith("project/") ? <>
      <ProjectsRoute subPath={subPath} copies={copies} projects={projects} hosts={hosts} locations={locations} loaded={loaded} overview={overview} open={open}/>
    </> : <ProjectWorkspace copies={copies} hosts={hosts} subPath={subPath}
      loaded={loaded} error={error} api={api} onOpen={open} historyGraph={historyGraph} reviewRevisions={reviewRevisions.byCopy}
      onOpenIssue={(accountId,repo,number) => open(refPath("issue",{accountId,repo,number}))}
      onAttach={async (hostId,root,projectId) => {
        const result = await client.call("attach",{hostId,root,projectId});
        return result.ok ? result.value : failed(result);
      }}
      renderHead={(copy,onFiles) => <BoundHead key={copy.id} copy={copy} client={client} onFiles={onFiles}/>}
      renderWorktree={(copy,host,attach) => <BoundWorktree key={copy.id} copy={copy} client={client} host={host} attach={attach}
        openReview={path => open(copy.id + "/review/" + encodeURIComponent(path))}
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
  app.slots.experimental_tab({...pullTab,title:"Pinned pull request",icon:"GitPullRequest",layout:"flush",component:withCodeTheme(PinnedPull)});
  app.slots.pendingInteraction({id:"git-confirm",component:Approval});
  app.slots.settingsSection({id:"main", component:withInterface(MainSettingsSection)});
  app.slots.navPanel({id:"git", title:"Git", icon:"GitBranch", path:"git", component:withCodeTheme(withInterface(Dashboard)), experimental_useBadge:useInboxBadge, experimental_sidebar:withInterface(ProjectsSidebar)});
  app.slots.experimental_tab({id:"git-thread", title:"Git", icon:"GitBranch", context:{kind:"thread"}, availability:"fixed", layout:"flush", component:withCodeTheme(ThreadGit)});
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"GitBranch", context:{kind:"thread"}, availability:"action", layout:"flush", component:withCodeTheme(PinnedGit)});
  app.slots.experimental_tab({...historyTab, title:"Git History", icon:"FolderGit", layout:"flush", component:ThreadHistory});
  app.slots.experimental_tab({...ciTab, title:"CI/CD", icon:"Workflow", layout:"flush", component:ThreadCi});
  app.slots.experimental_tab({...reviewTab, title:"Review", icon:"FileDiff", layout:"flush", component:withCodeTheme(ThreadReview)});
  // The Review's palette commands: each opens the thread's Review tab and leaves its action there.
  app.slots.experimental_appOverlay({id:"review-open", component:ReviewOpenOverlay});
  app.slots.experimental_appOverlay({id:"pr-links", component:PrLinkOverlay});
  app.slots.experimental_appOverlay({id:"pr-alerts", component:AlertToastsOverlay});
  app.commands.register({id:"review-open", title:"Makosh Git: review this thread's changes", isAvailable:context => context.threadId !== null,
    run:context => { context.experimental_panel.openTab({tab:reviewTab, title:"Review"}); }});
  for (const [id, title] of Object.entries(REVIEW_COMMANDS) as [ReviewCommand, string][]) {
    app.commands.register({id:"review-" + id, title:"Makosh Git Review: " + title, isAvailable:context => context.threadId !== null,
      run:context => {
        if (context.threadId === null) return;
        context.experimental_panel.openTab({tab:reviewTab, title:"Review"});
        dispatchReviewCommand(context.threadId, id);
      }});
  }
  registerHistoryShortcut(app.slots);
  registerReviewSurfaces(app.slots);
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"GitBranch", context:{kind:"nav-panel", panelId:"git"}, availability:"action", layout:"flush", component:withCodeTheme(PinnedGit)});
});
