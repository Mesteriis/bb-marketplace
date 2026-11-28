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
import { ciApi, codeReviewApi, failed, historyApi, okValue, pullRequestApi } from "./src/app/apis.tsx";
import { useCatalog } from "./src/app/catalog-data.tsx";
import { gitTab, pinnedCopyTab, pinnedPullTab, PinnedGitPage, PinnedGitThread, PinnedPull, registerThreadSurfaces, ThreadGit } from "./src/app/thread-panel.tsx";
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
const tab = pinnedCopyTab;
const pullTab = pinnedPullTab;



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
  const review = useMemo(() => pullRequestApi(client, navigate), [client, navigate]);
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
  app.slots.experimental_tab({...pullTab,title:"Pinned pull request",icon:"GitPullRequest",layout:"flush",component:withCodeTheme(withInterface(PinnedPull))});
  app.slots.pendingInteraction({id:"git-confirm",component:Approval});
  app.slots.settingsSection({id:"main", component:withInterface(MainSettingsSection)});
  app.slots.navPanel({id:"git", title:"Git", icon:"GitBranch", path:"git", component:withCodeTheme(withInterface(Dashboard)), experimental_useBadge:useInboxBadge, experimental_sidebar:withInterface(ProjectsSidebar)});
  // One Git tab beside a thread: the summary and every screen that had a tab of its own (History, CI/CD, Review).
  app.slots.experimental_tab({...gitTab, title:"Git", icon:"GitBranch", layout:"flush", component:withCodeTheme(withInterface(ThreadGit))});
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"Pin", context:{kind:"thread"}, availability:"action", layout:"flush", component:withCodeTheme(withInterface(PinnedGitThread))});
  // The Review's palette commands: each opens the thread's Git tab on its Review and leaves the action there.
  app.slots.experimental_appOverlay({id:"review-open", component:ReviewOpenOverlay});
  app.slots.experimental_appOverlay({id:"pr-links", component:PrLinkOverlay});
  app.slots.experimental_appOverlay({id:"pr-alerts", component:AlertToastsOverlay});
  app.commands.register({id:"review-open", title:"Makosh Git: review this thread's changes", isAvailable:context => context.threadId !== null,
    run:context => { context.experimental_panel.openTab({tab:gitTab, target:{screen:"review"}}); }});
  for (const [id, title] of Object.entries(REVIEW_COMMANDS) as [ReviewCommand, string][]) {
    app.commands.register({id:"review-" + id, title:"Makosh Git Review: " + title, isAvailable:context => context.threadId !== null,
      run:context => {
        if (context.threadId === null) return;
        context.experimental_panel.openTab({tab:gitTab, target:{screen:"review", command:id}});
      }});
  }
  registerThreadSurfaces(app.slots);
  app.slots.experimental_tab({id:tab.id, title:"Pinned Git", icon:"Pin", context:{kind:"nav-panel", panelId:"git"}, availability:"action", layout:"flush", component:withCodeTheme(withInterface(PinnedGitPage))});
});
