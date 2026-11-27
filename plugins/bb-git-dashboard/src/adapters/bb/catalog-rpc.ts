import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildCatalog, categoriesOf, keepFailedSources, remoteKey, type CatalogSource, type LocalProject } from "../../core/catalog/catalog.ts";
import { parseRemote } from "../../core/forge/remote-url.ts";
import type { Account, CatalogPage, Repo } from "../../core/providers.ts";
import { failureFor, type Failure } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";

type Caller = {experimental_caller: {kind: string}};
type Run<T> = Promise<{ok: true; value: T} | Failure>;
type Deps = {
  /** The projects folder and the names the walk skips, from the plugin's settings. */
  rules(): Promise<{root: string; exclude: string[]}>;
  accounts(): Promise<Account[]>;
  repositories(input: {accountId: string; page: number; refresh: boolean}): Run<CatalogPage>;
  pulls(input: {accountId: string; repoId: string; page: number}): Promise<{ok: true; items: unknown[]; more: boolean} | Failure>;
};
/** Pages read per account: 100 repositories a page on most forges, so a thousand or so. */
const maxPages = 10;
/** Repositories kept per account for a later failure: a kv value holds at most 256 KB, one repository is ~250 bytes. */
const kept = 700;
// Fetch and pull run on the machine for up to two minutes; the call waits a little longer than that.
const gitWait = 150_000;

/** The catalog of projects: one machine's projects folder against every connected account's repositories. */
export function catalogHandlers(bb: BbPluginApi, deps: Deps) {
  const host = bb.hosts.experimental_client({contract: hostContract});
  const kv = bb.storage.kv;
  // The last local listing per machine (bulk actions take each project's origin from it), and which accounts list
  // each repository (a fetch over HTTPS uses one of them).
  const lastLocal = new Map<string, {root: string; projects: LocalProject[]}>();
  const seenBy = new Map<string, string[]>();
  const readLocal = async (hostId: string) => {
    const {root, exclude} = await deps.rules();
    const local = await host.call("catalogLocal", {root, exclude}, {hostId, timeoutMs: 60_000});
    if (!local.ok) throw new Error(local.code);
    lastLocal.set(hostId, {root: local.root, projects: local.projects});
    return local;
  };
  // Each account's last listing under its own key, so one large account cannot outgrow a kv value for all.
  const cached = async (accounts: Account[]) => (await Promise.all(accounts.map(account => kv.get<CatalogSource>("catalog/source/" + account.id))))
    .filter((source): source is CatalogSource => source !== undefined);
  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "PROVIDER_UNAVAILABLE"); }
  };
  async function listAccount(account: Account, refresh: boolean): Promise<CatalogSource> {
    const summary = {id: account.id, label: account.label, kind: account.kind};
    const repos: Repo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const result = await deps.repositories({accountId: account.id, page, refresh});
      if (!result.ok) return {account: summary, ok: false, error: result.code, fetchedAt: null, repos};
      repos.push(...result.value.items);
      if (!result.value.more) break;
    }
    return {account: summary, ok: true, error: null, fetchedAt: new Date().toISOString(), repos};
  }
  return {
    catalogView: handle(async ({hostId, refresh}: {hostId: string; refresh: boolean}) => {
      const [local, accounts] = await Promise.all([readLocal(hostId), deps.accounts()]);
      const sources = keepFailedSources(await cached(accounts), await Promise.all(accounts.map(account => listAccount(account, refresh))));
      for (const source of sources) {
        if (!source.ok) continue;
        // The cache only serves a later failure: a value too large for kv is not worth failing the catalog over.
        await kv.set("catalog/source/" + source.account.id, {...source, repos: source.repos.slice(0, kept)})
          .catch(error => bb.log.warn("Catalog cache not saved: " + (error instanceof Error ? error.message : String(error))));
      }
      const catalog = buildCatalog(local.projects, sources);
      seenBy.clear();
      for (const row of catalog.remote) seenBy.set(row.key, row.accounts);
      return {root: local.root, truncated: local.truncated, ...catalog, categories: categoriesOf(local.root, local.projects.map(project => project.path))};
    }),
    catalogBulk: handle(async ({hostId, roots, action}: {hostId: string; roots: string[]; action: "status" | "fetch" | "pull"}) => {
      const {root} = await deps.rules();
      // After a restart of the server the page may still be open: read the folder again rather than guess.
      const known = lastLocal.get(hostId) ?? await readLocal(hostId);
      const accounts = action === "status" ? [] : await deps.accounts();
      const results = [];
      // One after another: a fetch per project at a time keeps the machine and the forges at ease.
      for (const project of roots) {
        // remotes[0] is origin (the host fetches from origin); its account is one that lists the repository, else one of its server.
        const origin = known.projects.find(entry => entry.path === project)?.remotes[0] ?? "";
        const remote = parseRemote(origin);
        const onServer = remote?.transport === "https" ? accounts.filter(entry => {
          try { return new URL(entry.origin).hostname.replace(/^api\./, "") === remote.host; } catch { return false; }
        }) : [];
        const listing = seenBy.get(remoteKey(origin) ?? "") ?? [];
        const account = onServer.find(entry => listing.includes(entry.id)) ?? onServer[0];
        const answer = await host.call("catalogGit", {projectsRoot: root, root: project, action, https: account ? {username: account.username} : null},
          {hostId, timeoutMs: action === "status" ? 30_000 : gitWait})
          .catch(() => failureFor(undefined, "HOST_UNAVAILABLE"));
        results.push(answer.ok ? {root: project, ok: true, code: null, value: answer.value}
          : {root: project, ok: false, code: remote?.transport === "https" && !account && answer.code === "ACCOUNT_TRANSPORT_REQUIRED" ? "NO_ACCOUNT" : answer.code, value: null});
      }
      if (action !== "status") bb.realtime.publish("git-workspace-changed", {copyId: null});
      return {results};
    }),
    catalogPulls: handle(async ({repos}: {repos: {accountId: string; repoId: string}[]}) => ({
      results: await Promise.all(repos.map(async target => {
        // The forges list pull requests of every state: the open ones are kept (Azure calls them active), from three pages at most.
        const open: {state: string}[] = [];
        for (let page = 1; page <= 3; page++) {
          const answer = await deps.pulls({...target, page});
          if (!answer.ok) return {...target, ok: false, code: answer.code, pulls: []};
          open.push(...(answer.items as {state: string}[]).filter(item => item.state === "open" || item.state === "active"));
          if (!answer.more) break;
        }
        return {...target, ok: true, code: null, pulls: open as never[]};
      })),
    })),
  };
}
