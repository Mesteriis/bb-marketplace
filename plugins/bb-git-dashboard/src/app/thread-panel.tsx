import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_DetailRow as DetailRow, experimental_THREAD_INFO_ROW_GROUPS, experimental_useAppPanel, experimental_useFixedTabTarget, useBbNavigate, useRealtime, useRpc,
  useSettings, type ExperimentalThreadInfoProps, type JsonValue, type PluginAppSlots, type PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { GitAction } from "../core/git.ts";
import { branchPull } from "../core/panel/summary.ts";
import { firstTime, targetScreen, type GitTarget } from "../core/panel/target.ts";
import type { InboxPr } from "../core/pulls/model.ts";
import type { Copy } from "../core/workspace.ts";
import { dispatchReviewCommand, type ReviewCommand } from "../ui/code-review/commands.ts";
import { useT } from "../ui/i18n/use-t.tsx";
import { GitPanel, type PanelApi, type PanelScreen } from "../ui/panel/git-panel.tsx";
import { PrPage } from "../ui/review/pr-page.tsx";
import { refPath } from "../ui/review/review-api.ts";
import { Icon } from "../ui/system/icon.tsx";
import { ciApi, codeReviewApi, failed, historyApi, pullRequestApi } from "./apis.tsx";
import { useCatalog } from "./catalog-data.tsx";
import { useInterfaceLanguage, withInterface } from "./interface.tsx";
import { format, type Language } from "../core/i18n/language.ts";
import { unpinTab } from "./pin-tabs.ts";
import { useReviewRevisions } from "./review-signal.ts";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
const signal = "git-workspace-changed";
const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;

const screens = new Set(["summary", "changes", "ci", "review", "history"]);
const isTarget = (value: JsonValue): value is GitTarget => !!value && typeof value === "object" && !Array.isArray(value)
  && typeof value.screen === "string" && screens.has(value.screen) && (value.runId === undefined || typeof value.runId === "string")
  && (value.command === undefined || typeof value.command === "string");
/** The thread's one Git tab: the summary, and every screen that had a tab of its own (History, CI/CD, Review). */
export const gitTab = {id: "git-thread", context: {kind: "thread"}, availability: "fixed", experimental_target: {validate: isTarget}} as const;
export const pinnedCopyTab = {id: "git-pinned", availability: "action"} as const;
export const pinnedPullTab = {id: "git-pinned-pr", availability: "action", context: {kind: "nav-panel", panelId: "git"}} as const;
// The targets whose Review command already ran, by thread: BB keeps a target across the tab's remounts.
const handled = new Map<string, number>();

// My PRs' open tab over every account, read once a minute at most for all the panels of this window; a change made
// here (`fresh`) reads it again. A failed read is not kept: it says so, and the next one asks again.
let openPulls: {at: number; value: Promise<InboxPr[]>} | null = null;
function readOpenPulls(client: Client, fresh: boolean) {
  if (fresh || !openPulls || Date.now() - openPulls.at > 60_000) {
    const value = client.call("inboxList", {tab: "open"}).then(result => {
      if (!result.ok || result.groups.some(group => group.error)) throw new Error(result.ok ? "PARTIAL" : result.code);
      return result.groups.flatMap(group => group.items);
    });
    const entry = {at: Date.now(), value};
    openPulls = entry;
    value.catch(() => { if (openPulls === entry) openPulls = null; });
  }
  return openPulls.value;
}

/** Unpin: closes the pinned tab; says so when the tab is no longer open. */
function UnpinButton({tab, params}: {tab: {id: string}; params: JsonValue | null}) {
  const t = useT();
  const panel = experimental_useAppPanel();
  const [missing, setMissing] = useState(false);
  return <>
    <button type="button" className="g-btn ghost sm" onClick={() => setMissing(!unpinTab(panel, tab, params))}>{t("gp.unpin")}</button>
    {missing && <span className="g-warn" role="alert">{t("gp.unpin-missing")}</span>}
  </>;
}

/** The path of an account's repository by its id, from the account's first five pages of repositories. */
export async function repositoryPath(client: Client, accountId: string, repoId: string): Promise<string | null> {
  for (let page = 1; page <= 5; page++) {
    const listed = await client.call("repositories", {accountId, page, refresh: false});
    if (!listed.ok) return null;
    const found = listed.value.items.find(item => item.id === repoId);
    if (found) return found.path;
    if (!listed.value.more) return null;
  }
  return null;
}

function usePanelApis(client: Client) {
  const navigate = useBbNavigate();
  const panel = useMemo<PanelApi>(() => ({
    pull: async (copy, branch, fresh) => branchPull(await readOpenPulls(client, fresh), branch, copy.repository ?? null),
    forge: async copyId => {
      const result = await client.call("forgeStatus", {copyId, recheck: false});
      const kind = result.ok ? result.value.detection?.kind ?? null : null;
      return kind ? forgeNames[kind] : null;
    },
    reviewCounts: async copyId => {
      const result = await client.call("reviewSummaries", {});
      const own = result.ok ? result.reviews.filter(review => review.copyId === copyId) : [];
      return {open: own.reduce((sum, review) => sum + review.open, 0), total: own.reduce((sum, review) => sum + review.total, 0)};
    },
  }), [client]);
  const ci = useMemo(() => ciApi(client, navigate), [client, navigate]);
  const history = useMemo(() => historyApi(client), [client]);
  const review = useMemo(() => codeReviewApi(client, navigate), [client, navigate]);
  const openPull = useCallback((pull: InboxPr) => navigate.toPluginPanel("git", {subPath: refPath("pr", {accountId: pull.accountId, repo: pull.repo, number: pull.number})}),
    [navigate]);
  return {panel, ci, history, review, openPull};
}

/** A copy's Git panel with its Git calls bound; `beside` is the thread it stands next to. */
function BoundPanel({copy, host, beside, screen, onScreen, note, footer}: {copy: Copy; host: string; beside?: string; screen: PanelScreen; onScreen(screen: PanelScreen): void;
  note?: React.ReactNode; footer?: React.ReactNode}) {
  const client = useRpc<typeof rpc>();
  const apis = usePanelApis(client);
  const [refresh, setRefresh] = useState(0);
  useRealtime(signal, useCallback(() => setRefresh(value => value + 1), []));
  const revisions = useReviewRevisions();
  const graph = useSettings().values?.historyGraph !== false;
  const run = useCallback(async (action: GitAction) => {
    const result = await client.call("git", {copyId: copy.id, action});
    if (!result.ok) return failed(result);
    return result.value;
  }, [client, copy.id]);
  const operations = useCallback(() => client.call("operations", {copyId: copy.id}), [client, copy.id]);
  return <GitPanel copy={copy} host={host} run={run} refresh={refresh} loadOperations={operations} api={apis.panel} ci={apis.ci} history={apis.history} review={apis.review}
    threadId={beside} reviewRevision={revisions.byCopy[copy.id] ?? 0} graph={graph} screen={screen} onScreen={onScreen} onOpenPull={apis.openPull} note={note} footer={footer}/>;
}

/** The thread's Git tab: the working copy of its environment, with the agent's access to it under the summary. */
export function ThreadGit({threadId}: {threadId: string}) {
  const t = useT();
  const client = useRpc<typeof rpc>();
  // The machine is said by its name; while the names are read, by nothing rather than its id.
  const {hosts} = useCatalog();
  const [context, setContext] = useState<Awaited<ReturnType<typeof read>>>();
  const [error, setError] = useState("");
  const [screen, setScreen] = useState<PanelScreen>({kind: "summary"});
  const target = experimental_useFixedTabTarget(gitTab);
  function read() { return client.call("context", {threadId}); }
  const refresh = useCallback(() => {
    client.call("context", {threadId}).then(value => { setContext(value); setError(""); }, () => setError(t("gp.context-failed")));
  }, [client, threadId, t]);
  useEffect(refresh, [refresh]);
  useRealtime(signal, refresh);
  // A header button, a command or the Info row asked for a screen (and maybe a Review command run there).
  useEffect(() => {
    if (!target) return;
    setScreen(targetScreen(target.target));
    if (target.target.command && firstTime(handled, threadId, target.sequence)) dispatchReviewCommand(threadId, target.target.command as ReviewCommand);
  }, [target?.sequence]);
  const onScreen = (next: PanelScreen) => { setScreen(next); if (next.kind === "summary") target?.clear(); };
  async function authorize(permission: "none" | "read" | "write") {
    if (!context?.ok) return;
    try {
      const result = await client.call("permission", {threadId, copyId: context.copy.id, permission});
      if (!result.ok) return failed(result);
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="git-ws">
    {error && <div className="g-banner bad" role="alert"><span>{error}</span><button type="button" className="g-btn sm" onClick={refresh}>{t("gp.retry")}</button></div>}
    {!context ? !error && <p className="g-state-page" role="status">{t("gp.reading")}</p> : !context.ok
      ? <p className="g-state-page">{t("gp.no-copy", {code: context.code})}</p>
      : <BoundPanel key={context.copy.id} copy={context.copy} host={hosts.find(item => item.id === context.copy.hostId)?.name ?? ""} beside={threadId} screen={screen} onScreen={onScreen}
        footer={<label className="git-panel-footer">{t("gp.access")}
          <select className="g-inp" value={context.permission} onChange={event => void authorize(event.target.value as "none" | "read" | "write")}>
            <option value="none">{t("gp.access.none")}</option><option value="read">{t("gp.access.read")}</option><option value="write">{t("gp.access.write")}</option>
          </select></label>}/>}
  </div>;
}

/** A pinned copy beside a thread: the same panel, saying it is not the thread's working copy, with Unpin. */
export function PinnedGitThread({params}: {params: JsonValue | null}) { return <PinnedGit params={params} beside/>; }
/** A pinned copy in the Git page's side panel: the same panel with Unpin. */
export function PinnedGitPage({params}: {params: JsonValue | null}) { return <PinnedGit params={params}/>; }

function PinnedGit({params, beside = false}: {params: JsonValue | null; beside?: boolean}) {
  const t = useT();
  const {copies, hosts, loaded} = useCatalog();
  const [screen, setScreen] = useState<PanelScreen>({kind: "summary"});
  const copyId = params && typeof params === "object" && !Array.isArray(params) ? params.copyId : undefined;
  const copy = copies.find(item => item.id === copyId);
  const note = <p className="git-panel-note"><Icon name="Pin" small/>{t(beside ? "gp.pinned-copy" : "gp.pinned-copy-page")}
    <UnpinButton tab={pinnedCopyTab} params={params}/></p>;
  return <div className="git-ws">{copy
    ? <BoundPanel key={copy.id} copy={copy} host={hosts.find(host => host.id === copy.hostId)?.name ?? ""} screen={screen} onScreen={setScreen} note={note}/>
    : <p className="g-state-page">{loaded ? t("gp.pinned-gone") : t("gp.pinned-reading")}</p>}</div>;
}

/** A pinned pull request: its page, narrow, under a line naming the repository and the forge, with Unpin. */
export function PinnedPull({params}: {params: JsonValue | null}) {
  const t = useT();
  const client = useRpc<typeof rpc>();
  const navigate = useBbNavigate();
  const api = useMemo(() => pullRequestApi(client, navigate), [client, navigate]);
  const target = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const {accountId, repoId, number} = target;
  const [place, setPlace] = useState<{repo: string; forge: string} | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (typeof accountId !== "string" || typeof number !== "number") { setError(t("gp.pr-unreadable")); return; }
    setError("");
    (async () => {
      const accounts = await client.call("accounts", null);
      const account = accounts.ok ? accounts.items.find(item => item.id === accountId) : undefined;
      // Pins made before 0.14.7 keep the repository's id only: its path is found among the account's repositories.
      const repo = typeof target.repo === "string" ? target.repo : typeof repoId === "string" ? await repositoryPath(client, accountId, repoId) : null;
      if (!active) return;
      if (!repo) { setError(t("gp.pr-unreadable")); return; }
      setPlace({repo, forge: account ? forgeNames[account.kind] : ""});
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [client, accountId, repoId, number, target.repo, t]);
  return <div className="git-ws git-panel">
    <p className="git-panel-note git-panel-pin"><Icon name="Pin" small/>{t("gp.pinned-pr", {repo: place?.repo ?? "…", forge: place?.forge ?? ""})}
      <UnpinButton tab={pinnedPullTab} params={params}/></p>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {place && typeof accountId === "string" && typeof number === "number"
      ? <PrPage api={api} accountId={accountId} repo={place.repo} number={number}/>
      : !error && <p className="g-state-page" role="status">{t("gp.pr-reading")}</p>}
  </div>;
}

// The header buttons' labels follow the interface language: the SDK takes `label` from `item`, which reads what
// `useData` (a hook) returned; only the registration's `title` (the quick-action picker's name) is static.
type Shortcut = {on: boolean; language: Language};
const headerShortcut: PluginThreadActionRegistration<Shortcut> = {
  id: "git-history-header", title: "Git History", icon: "GitBranch", group: "git", placement: "header",
  useData: () => ({on: useSettings().values?.historyHeaderShortcut === true, language: useInterfaceLanguage()}),
  item: ({data, experimental_panel}) => data.on ? {
    label: format(data.language, "gp.head-history"), icon: "GitBranch",
    run: () => { experimental_panel.openTab({tab: gitTab, target: {screen: "history"}}); },
  } : null,
};
const reviewShortcut: PluginThreadActionRegistration<Shortcut> = {
  id: "git-review-header", title: "Review", icon: "FileDiff", group: "git", placement: "header",
  useData: () => ({on: useSettings().values?.reviewHeaderShortcut !== false, language: useInterfaceLanguage()}),
  item: ({data, experimental_panel}) => data.on ? {
    label: format(data.language, "gp.head-review"), icon: "FileDiff",
    // Opens the Git tab on its Review (a toggle would close the panel when the Git tab shows another screen).
    run: () => { experimental_panel.openTab({tab: gitTab, target: {screen: "review"}}); },
  } : null,
};

/** "N open of M comment threads" in the thread's Info, with Open; nothing for a copy without threads. */
function ReviewInfoRow({threadId}: ExperimentalThreadInfoProps) {
  const t = useT();
  const client = useRpc<typeof rpc>();
  const panel = experimental_useAppPanel();
  const [counts, setCounts] = useState<{copyId: string; open: number; total: number} | null>(null);
  const revisions = useReviewRevisions();
  const revision = counts ? revisions.byCopy[counts.copyId] ?? 0 : revisions.any;
  useEffect(() => {
    let active = true;
    client.call("reviewThreadCounts", {threadId}).then(result => { if (active) setCounts(result.ok ? result.counts : null); }, () => {});
    return () => { active = false; };
  }, [client, threadId, revision]);
  if (!counts?.total) return null;
  return <DetailRow label={t("gp.review")} icon="FileDiff">
    <span>{counts.open ? t("gp.review-of", {open: counts.open, total: counts.total}) : t("gp.review-closed", {n: counts.total})}</span>{" "}
    <button type="button" className="git-link" onClick={() => panel.openTab({tab: gitTab, target: {screen: "review"}})}>{t("gp.open")}</button>
  </DetailRow>;
}

/** The thread header's Git History and Review buttons and the Review row of the thread's Info: each opens the Git tab there. */
export function registerThreadSurfaces(slots: PluginAppSlots) {
  slots.experimental_threadAction(headerShortcut);
  slots.experimental_threadAction(reviewShortcut);
  slots.experimental_threadInfoRow({id: "git-review", group: experimental_THREAD_INFO_ROW_GROUPS.git, component: withInterface(ReviewInfoRow)});
}
