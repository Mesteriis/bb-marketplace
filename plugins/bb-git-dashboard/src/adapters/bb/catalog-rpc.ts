import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildCatalog, categoriesOf, keepFailedSources, type CatalogSource, type LocalProject } from "../../core/catalog/catalog.ts";
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

/** The catalog of projects: one machine's projects folder against every connected account's repositories. */
export function catalogHandlers(bb: BbPluginApi, deps: Deps) {
  const host = bb.hosts.experimental_client({contract: hostContract});
  const kv = bb.storage.kv;
  // The last local listing per machine: bulk actions pick each project's transport from its remotes.
  const lastLocal = new Map<string, {root: string; projects: LocalProject[]}>();
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
      const {root, exclude} = await deps.rules();
      const [local, accounts] = await Promise.all([host.call("catalogLocal", {root, exclude}, {hostId}), deps.accounts()]);
      if (!local.ok) throw new Error(local.code);
      lastLocal.set(hostId, {root: local.root, projects: local.projects});
      const previous = await kv.get<CatalogSource[]>("catalog/sources") ?? [];
      const sources = keepFailedSources(previous, await Promise.all(accounts.map(account => listAccount(account, refresh))));
      await kv.set("catalog/sources", sources);
      return {root: local.root, truncated: local.truncated, ...buildCatalog(local.projects, sources),
        categories: categoriesOf(local.root, local.projects.map(project => project.path))};
    }),
    catalogBulk: handle(async ({hostId, roots, action}: {hostId: string; roots: string[]; action: "status" | "fetch" | "pull"}) => {
      const {root} = await deps.rules();
      const known = lastLocal.get(hostId);
      const accounts = action === "status" ? [] : await deps.accounts();
      const results = [];
      // One after another: a fetch per project at a time keeps the machine and the forges at ease.
      for (const project of roots) {
        const remote = parseRemote(known?.projects.find(entry => entry.path === project)?.remotes[0] ?? "");
        const account = remote?.transport === "https" ? accounts.find(entry => {
          try { return new URL(entry.origin).hostname.replace(/^api\./, "") === remote.host; } catch { return false; }
        }) : undefined;
        const answer = await host.call("catalogGit", {projectsRoot: root, root: project, action, https: account ? {username: account.username} : null}, {hostId})
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
